//! EventSub supplements IRC only for events IRC cannot deliver.
use serde_json::{json, Value};

use crate::state::{AppState, Auth};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub kind: &'static str,
    pub version: &'static str,
    pub condition: Value,
    pub channel: String,
}

fn has_either(auth: &Auth, account: &str, read: &str, manage: &str) -> bool {
    auth.has_scope(account, read) || auth.has_scope(account, manage)
}

fn can_read_moderation(auth: &Auth, account: &str) -> bool {
    [
        "blocked_terms",
        "chat_settings",
        "unban_requests",
        "banned_users",
        "chat_messages",
        "warnings",
    ]
    .iter()
    .all(|scope| {
        has_either(
            auth,
            account,
            &format!("moderator:read:{scope}"),
            &format!("moderator:manage:{scope}"),
        )
    }) && auth.has_scope(account, "moderator:read:moderators")
        && auth.has_scope(account, "moderator:read:vips")
}

/// Derived afresh from open tabs, room IDs, USERSTATE roles and granted scopes.
pub fn wanted(state: &AppState, account: &str) -> Vec<Subscription> {
    let channels = state.wanted().remove(account).unwrap_or_default();
    let auth = state.auth.read().clone();
    if auth.account(account).is_none() || channels.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    if has_either(&auth, account, "user:read:whispers", "user:manage:whispers") {
        result.push(Subscription {
            kind: "user.whisper.message",
            version: "1",
            condition: json!({"user_id": account}),
            channel: String::new(),
        });
    }
    // Do not nest room and session locks: history rendering reads room assets
    // while it holds its session guard.
    let rooms: Vec<_> = {
        let data = state.data.read();
        channels
            .into_iter()
            .filter_map(|channel| {
                let room = data.get(&channel)?.room_id.clone()?;
                Some((channel, room))
            })
            .collect()
    };
    let sessions = state.sessions.read();
    for (channel, room) in rooms {
        let moderator = room == account
            || sessions
                .get(&(account.to_string(), channel.clone()))
                .is_some_and(|session| session.role.moderator);
        result.extend(channel_subscriptions(
            &auth, account, &channel, &room, moderator,
        ));
    }
    result
}

fn channel_subscriptions(
    auth: &Auth,
    account: &str,
    channel: &str,
    room: &str,
    moderator: bool,
) -> Vec<Subscription> {
    let mut result = Vec::new();
    let mut add = |kind, version, condition| {
        result.push(Subscription {
            kind,
            version,
            condition,
            channel: channel.to_string(),
        })
    };
    let room_condition = json!({"broadcaster_user_id": room});
    for kind in [
        "channel.shared_chat.begin",
        "channel.shared_chat.update",
        "channel.shared_chat.end",
    ] {
        add(kind, "1", room_condition.clone());
    }
    if auth.has_scope(account, "user:read:chat") {
        for kind in [
            "channel.chat.user_message_hold",
            "channel.chat.user_message_update",
        ] {
            add(
                kind,
                "1",
                json!({"broadcaster_user_id": room, "user_id": account}),
            );
        }
    }
    let moderate = moderator && can_read_moderation(auth, account);
    if moderate {
        add(
            "channel.moderate",
            "2",
            json!({"broadcaster_user_id": room, "moderator_user_id": account}),
        );
    }
    if moderator
        && has_either(
            auth,
            account,
            "moderator:read:shoutouts",
            "moderator:manage:shoutouts",
        )
    {
        for kind in ["channel.shoutout.create", "channel.shoutout.receive"] {
            add(
                kind,
                "1",
                json!({"broadcaster_user_id": room, "moderator_user_id": account}),
            );
        }
    }
    if room == account {
        // channel.moderate already covers these, so never subscribe to both.
        if !moderate && auth.has_scope(account, "moderation:read") {
            for kind in [
                "channel.unban",
                "channel.moderator.add",
                "channel.moderator.remove",
            ] {
                add(kind, "1", room_condition.clone());
            }
        }
        if !moderate && has_either(auth, account, "channel:read:vips", "channel:manage:vips") {
            for kind in ["channel.vip.add", "channel.vip.remove"] {
                add(kind, "1", room_condition.clone());
            }
        }
        if auth.has_scope(account, "channel:read:hype_train") {
            for kind in [
                "channel.hype_train.begin",
                "channel.hype_train.progress",
                "channel.hype_train.end",
            ] {
                add(kind, "2", room_condition.clone());
            }
        }
    }
    result
}

fn string<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event[key].as_str().filter(|value| !value.is_empty())
}

fn name(event: &Value) -> Option<&str> {
    string(event, "user_name").or_else(|| string(event, "user_login"))
}

pub fn unbanned_login<'a>(kind: &str, event: &'a Value) -> Option<&'a str> {
    if kind == "channel.unban" {
        return string(event, "user_login");
    }
    if kind != "channel.moderate" {
        return None;
    }
    let action = string(event, "action")?;
    match action {
        "unban" | "untimeout" | "shared_chat_unban" | "shared_chat_untimeout" => {
            string(&event[action], "user_login")
        }
        _ => None,
    }
}

/// Private AutoMod messages must belong to this socket's account. They are
/// rendered as notices, so they cannot be collected by mention listeners.
pub fn describe(kind: &str, event: &Value, account: &str) -> Option<String> {
    Some(match kind {
        "channel.chat.user_message_hold" | "channel.chat.user_message_update" => {
            if string(event, "user_id")? != account {
                return None;
            }
            let status = if kind.ends_with("_hold") {
                "held for review"
            } else {
                match string(event, "status")? {
                    "approved" => "approved",
                    "denied" => "denied",
                    "invalid" => "no longer pending review",
                    _ => return None,
                }
            };
            let body = string(&event["message"], "text")?;
            format!("AutoMod: your message was {status}: {body}")
        }
        "channel.shared_chat.begin" | "channel.shared_chat.update" => {
            let status = if kind.ends_with("begin") {
                "started"
            } else {
                "updated"
            };
            let participants: Vec<_> = event["participants"]
                .as_array()?
                .iter()
                .filter_map(|p| {
                    string(p, "broadcaster_user_name")
                        .or_else(|| string(p, "broadcaster_user_login"))
                })
                .collect();
            format!("Shared chat {status}: {}.", participants.join(", "))
        }
        "channel.shared_chat.end" => "Shared chat ended for this channel.".to_string(),
        "channel.moderator.add" => format!("{} was added as a moderator.", name(event)?),
        "channel.moderator.remove" => format!("{} was removed as a moderator.", name(event)?),
        "channel.vip.add" => format!("{} was added as a VIP.", name(event)?),
        "channel.vip.remove" => format!("{} was removed as a VIP.", name(event)?),
        "channel.unban" => format!(
            "{} was unbanned or had their timeout removed.",
            name(event)?
        ),
        "channel.hype_train.begin" | "channel.hype_train.progress" => {
            let status = if kind.ends_with("begin") {
                "started"
            } else {
                "progress"
            };
            format!(
                "Hype Train {status}: level {}, {} / {} points.",
                event["level"].as_u64()?,
                event["progress"].as_u64()?,
                event["goal"].as_u64()?
            )
        }
        "channel.hype_train.end" => format!(
            "Hype Train ended at level {} with {} total points.",
            event["level"].as_u64()?,
            event["total"].as_u64()?
        ),
        "channel.shoutout.create" => format!(
            "Shoutout sent to {} ({} viewers).",
            string(event, "to_broadcaster_user_name")
                .or_else(|| string(event, "to_broadcaster_user_login"))?,
            event["viewer_count"].as_u64()?
        ),
        "channel.shoutout.receive" => format!(
            "Shoutout received from {} ({} viewers).",
            string(event, "from_broadcaster_user_name")
                .or_else(|| string(event, "from_broadcaster_user_login"))?,
            event["viewer_count"].as_u64()?
        ),
        "channel.moderate" => return describe_moderation(event),
        _ => return None,
    })
}

fn describe_moderation(event: &Value) -> Option<String> {
    let action = string(event, "action")?;
    let moderator =
        string(event, "moderator_user_name").or_else(|| string(event, "moderator_user_login"))?;
    let detail = &event[action];
    // IRC supplies bans, timeouts, clears, deletions, raids and room settings
    // to every viewer. Suppress their EventSub copies, even for moderators.
    Some(match action {
        "unban" | "shared_chat_unban" => format!("{moderator} unbanned {}.", name(detail)?),
        "untimeout" | "shared_chat_untimeout" => {
            format!("{moderator} removed the timeout for {}.", name(detail)?)
        }
        "mod" => format!("{moderator} added {} as a moderator.", name(detail)?),
        "unmod" => format!("{moderator} removed {} as a moderator.", name(detail)?),
        "vip" => format!("{moderator} added {} as a VIP.", name(detail)?),
        "unvip" => format!("{moderator} removed {} as a VIP.", name(detail)?),
        "warn" => {
            let reason = string(detail, "reason")
                .map(str::to_string)
                .or_else(|| {
                    detail["chat_rules_cited"].as_array().map(|rules| {
                        rules
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                })
                .unwrap_or_default();
            format!("{moderator} warned {}. {reason}", name(detail)?)
        }
        "add_blocked_term"
        | "add_permitted_term"
        | "remove_blocked_term"
        | "remove_permitted_term" => {
            // Do not expose the terms themselves in the chat log.
            format!(
                "{moderator} updated AutoMod terms ({}).",
                action.replace('_', " ")
            )
        }
        "approve_unban_request" | "deny_unban_request" => {
            let verb = if action.starts_with("approve") {
                "approved"
            } else {
                "denied"
            };
            format!(
                "{moderator} {verb} the unban request for {}.",
                name(&event["unban_request"])?
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::settings::{Account, Tab};
    use crate::state::{ChannelData, Session};

    pub(crate) fn fixture() -> AppState {
        let state = AppState::new();
        state.auth.write().accounts.push(Account {
            id: "1".into(),
            login: "viewer".into(),
            access_token: "test".into(),
            refresh_token: String::new(),
            scopes: crate::auth::scope_string(&["moderation".into(), "channel".into()])
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            avatar_url: String::new(),
        });
        state.tabs.write().push(Tab {
            id: "tab".into(),
            kind: "channel".into(),
            channel: "room".into(),
            account: "1".into(),
            avatar_mode: None,
            mention: None,
        });
        state.data.write().insert(
            "room".into(),
            ChannelData {
                room_id: Some("2".into()),
                ..Default::default()
            },
        );
        state
            .sessions
            .write()
            .insert(("1".into(), "room".into()), Session::default());
        state
    }

    #[test]
    fn viewer_gets_public_events_and_only_their_own_automod_events() {
        let state = fixture();
        let specs = wanted(&state, "1");
        assert_eq!(specs.len(), 6); // whisper, shared chat x3, personal AutoMod x2
        let hold = specs
            .iter()
            .find(|s| s.kind == "channel.chat.user_message_hold")
            .unwrap();
        assert_eq!(
            hold.condition,
            json!({"broadcaster_user_id":"2", "user_id":"1"})
        );
        assert!(!specs.iter().any(|s| s.kind == "channel.moderate"));
        assert!(!specs
            .iter()
            .any(|s| s.kind.starts_with("channel.hype_train")));
    }

    #[test]
    fn roles_and_granted_scopes_both_gate_privileged_events() {
        let state = fixture();
        state
            .sessions
            .write()
            .get_mut(&("1".into(), "room".into()))
            .unwrap()
            .role
            .moderator = true;
        assert!(wanted(&state, "1")
            .iter()
            .any(|s| s.kind == "channel.moderate" && s.version == "2"));
        assert!(wanted(&state, "1")
            .iter()
            .any(|s| s.kind == "channel.shoutout.receive"));
        state.auth.write().accounts[0]
            .scopes
            .retain(|s| s != "moderator:read:vips");
        assert!(!wanted(&state, "1")
            .iter()
            .any(|s| s.kind == "channel.moderate"));
        state.auth.write().accounts[0].scopes.clear();
        assert_eq!(wanted(&state, "1").len(), 3);
    }

    #[test]
    fn broadcaster_events_have_no_duplicate_role_subscriptions() {
        let state = fixture();
        state.data.write().get_mut("room").unwrap().room_id = Some("1".into());
        let specs = wanted(&state, "1");
        assert_eq!(
            specs
                .iter()
                .filter(|s| s.kind.starts_with("channel.hype_train") && s.version == "2")
                .count(),
            3
        );
        assert!(specs.iter().any(|s| s.kind == "channel.moderate"));
        assert!(!specs.iter().any(|s| s.kind == "channel.vip.add"
            || s.kind == "channel.moderator.add"
            || s.kind == "channel.unban"));
        state.auth.write().accounts[0]
            .scopes
            .retain(|s| !s.starts_with("moderator:"));
        let specs = wanted(&state, "1");
        for kind in [
            "channel.vip.add",
            "channel.vip.remove",
            "channel.moderator.add",
            "channel.moderator.remove",
            "channel.unban",
        ] {
            assert!(specs.iter().any(|s| s.kind == kind), "{kind}");
        }
    }

    #[test]
    fn closing_tabs_and_signing_out_remove_subscriptions() {
        let state = fixture();
        let mut duplicate = state.tabs.read()[0].clone();
        duplicate.id = "duplicate".into();
        state.tabs.write().push(duplicate);
        assert_eq!(wanted(&state, "1").len(), 6);
        assert!(wanted(&state, "").is_empty());
        assert!(wanted(&state, "other-account").is_empty());
        state.tabs.write().clear();
        assert!(wanted(&state, "1").is_empty());
    }

    #[test]
    fn automod_is_private_and_every_status_has_a_description() {
        let mut event =
            json!({"user_id":"1", "message_id":"message-1", "message":{"text":"banphrase"}});
        assert_eq!(
            describe("channel.chat.user_message_hold", &event, "1").as_deref(),
            Some("AutoMod: your message was held for review: banphrase")
        );
        assert!(describe("channel.chat.user_message_hold", &event, "2").is_none());
        for (status, label) in [
            ("approved", "approved"),
            ("denied", "denied"),
            ("invalid", "no longer pending review"),
        ] {
            event["status"] = json!(status);
            assert_eq!(
                describe("channel.chat.user_message_update", &event, "1"),
                Some(format!("AutoMod: your message was {label}: banphrase"))
            );
        }
        event["status"] = json!("future");
        assert!(describe("channel.chat.user_message_update", &event, "1").is_none());
    }

    #[test]
    fn shared_chat_hype_trains_roles_and_shoutouts_render_payload_details() {
        for (kind, event, expected) in [
            (
                "channel.shared_chat.begin",
                json!({"participants":[{"broadcaster_user_name":"Alice"},{"broadcaster_user_login":"bob"}]}),
                "Shared chat started: Alice, bob.",
            ),
            (
                "channel.shared_chat.update",
                json!({"participants":[{"broadcaster_user_name":"Alice"}]}),
                "Shared chat updated: Alice.",
            ),
            (
                "channel.shared_chat.end",
                json!({}),
                "Shared chat ended for this channel.",
            ),
            (
                "channel.hype_train.begin",
                json!({"level":1,"progress":250,"goal":1000}),
                "Hype Train started: level 1, 250 / 1000 points.",
            ),
            (
                "channel.hype_train.progress",
                json!({"level":2,"progress":750,"goal":1500}),
                "Hype Train progress: level 2, 750 / 1500 points.",
            ),
            (
                "channel.hype_train.end",
                json!({"level":2,"total":1750}),
                "Hype Train ended at level 2 with 1750 total points.",
            ),
            (
                "channel.shoutout.create",
                json!({"to_broadcaster_user_name":"Alice","viewer_count":42}),
                "Shoutout sent to Alice (42 viewers).",
            ),
            (
                "channel.shoutout.receive",
                json!({"from_broadcaster_user_name":"Bob","viewer_count":50}),
                "Shoutout received from Bob (50 viewers).",
            ),
            (
                "channel.vip.add",
                json!({"user_name":"Alice"}),
                "Alice was added as a VIP.",
            ),
            (
                "channel.vip.remove",
                json!({"user_login":"alice"}),
                "alice was removed as a VIP.",
            ),
            (
                "channel.moderator.add",
                json!({"user_name":"Alice"}),
                "Alice was added as a moderator.",
            ),
            (
                "channel.moderator.remove",
                json!({"user_name":"Alice"}),
                "Alice was removed as a moderator.",
            ),
            (
                "channel.unban",
                json!({"user_name":"Alice"}),
                "Alice was unbanned or had their timeout removed.",
            ),
        ] {
            assert_eq!(
                describe(kind, &event, "1").as_deref(),
                Some(expected),
                "{kind}"
            );
        }
        assert!(describe("channel.hype_train.progress", &json!({"level":2}), "1").is_none());
        assert!(describe("not.a.real.event", &json!({}), "1").is_none());
    }

    #[test]
    fn moderation_suppresses_irc_duplicates_and_clears_only_confirmed_unbans() {
        for action in [
            "ban",
            "timeout",
            "clear",
            "delete",
            "slow",
            "subscribers",
            "raid",
            "shared_chat_ban",
        ] {
            let event = json!({"action":action,"moderator_user_name":"Mod"});
            assert!(describe("channel.moderate", &event, "1").is_none());
            assert!(unbanned_login("channel.moderate", &event).is_none());
        }
        for action in [
            "unban",
            "untimeout",
            "shared_chat_unban",
            "shared_chat_untimeout",
            "mod",
            "unmod",
            "vip",
            "unvip",
            "warn",
        ] {
            let mut event = json!({"action":action,"moderator_user_name":"Mod"});
            event[action] = json!({"user_login":"alice","reason":"No spoilers"});
            assert!(describe("channel.moderate", &event, "1")
                .unwrap()
                .contains("alice"));
            assert_eq!(
                unbanned_login("channel.moderate", &event).is_some(),
                action.contains("unban") || action.contains("untimeout")
            );
        }
    }
}
