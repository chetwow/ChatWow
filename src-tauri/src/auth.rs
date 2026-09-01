//! Twitch OAuth Device Code Flow.
//!
//! The app is registered as a *public* client, so there is no client secret --
//! we exchange a device code for tokens and refresh the same way.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";

/// One block of scopes the sign-in screen offers as a single choice.
///
/// Twitch's consent screen lists every scope individually and asks once, at
/// sign-in, for all of them -- there's no way to escalate later without going
/// back through the whole flow. So the choice is offered up front and grouped
/// by what it buys you, rather than as fifteen checkboxes named after API
/// scopes. Only the chat group is required; everything else is off until
/// someone wants the commands behind it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGroup {
    pub id: &'static str,
    pub label: &'static str,
    /// Why you'd want it -- shown as the checkbox's tooltip.
    pub detail: &'static str,
    pub scopes: &'static [&'static str],
    /// Asked for on every sign-in. The UI shows it but won't let you clear it.
    pub required: bool,
}

/// Every group, in the order the sign-in screen lists them.
pub const PERMISSION_GROUPS: &[PermissionGroup] = &[
    // `user:write:chat` is what lets us send through Helix's chat-messages
    // endpoint instead of raw IRC PRIVMSG -- the only way to learn the real id
    // Twitch assigns an outgoing message (IRC never echoes it back to us),
    // which in turn is what makes replying to your own messages work.
    PermissionGroup {
        id: "chat",
        label: "Read and send chat",
        detail: "Reading chat and sending messages. Always requested -- it's what \
                 signing in is for.",
        scopes: &["chat:read", "chat:edit", "user:write:chat"],
        required: true,
    },
    PermissionGroup {
        id: "account",
        label: "Your own account",
        detail: "Needed for the commands that act on your account rather than a channel: \
                 /color, /block, /unblock and /w.",
        scopes: &[
            "user:manage:chat_color",
            "user:manage:blocked_users",
            "user:manage:whispers",
        ],
        // Not optional, deliberately. These act on your own account and can't
        // reach a channel, so there's nothing to weigh up -- and someone who
        // turned them off would find out by sending a whisper that silently
        // couldn't go anywhere.
        required: true,
    },
    PermissionGroup {
        id: "moderation",
        label: "Moderator commands",
        detail: "Needed to run the moderator commands -- /ban, /timeout, /clear, /slow, \
                 /announce and the rest.",
        scopes: &[
            "moderator:manage:banned_users",
            "moderator:manage:chat_messages",
            "moderator:manage:chat_settings",
            "moderator:manage:announcements",
            "moderator:manage:shoutouts",
            "moderator:manage:warnings",
        ],
        required: false,
    },
    PermissionGroup {
        id: "channel",
        label: "Broadcaster commands",
        detail: "Needed to run the broadcaster commands -- /mod, /vip, /raid, /commercial \
                 and /marker.",
        scopes: &[
            "channel:manage:moderators",
            "channel:manage:vips",
            "channel:manage:raids",
            "channel:edit:commercial",
            "channel:manage:broadcast",
        ],
        required: false,
    },
];

/// The space-separated scope string to ask Twitch for: every required group,
/// plus the ones chosen by id. An id we don't recognize is ignored rather than
/// rejected -- the settings file is hand-editable, and a stale group name
/// shouldn't stop anyone signing in.
pub fn scope_string(groups: &[String]) -> String {
    let mut scopes: Vec<&str> = Vec::new();
    for group in PERMISSION_GROUPS {
        if !group.required && !groups.iter().any(|id| id == group.id) {
            continue;
        }
        for scope in group.scopes {
            if !scopes.contains(scope) {
                scopes.push(scope);
            }
        }
    }
    scopes.join(" ")
}

/// The Client ID baked in at build time:
///
///   TWITCH_CLIENT_ID=<id> npm run tauri build
///
/// A Client ID is a public identifier, not a secret -- it travels in the clear
/// on every OAuth request, so shipping it in the binary is the intended usage.
/// The client *secret* is the confidential half, and the device code flow never
/// needs one, which is exactly why this app is registered as a public client.
///
/// When it's absent (a plain `cargo build` during development) the app falls
/// back to a Client ID pasted into the account dialog.
pub const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("TWITCH_CLIENT_ID");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Validation {
    pub login: String,
    pub user_id: String,
    /// What the token actually carries, which is the only trustworthy answer
    /// to "can I run this command" -- a token predates any later change to
    /// which groups are ticked, and Twitch grants what the user approved
    /// rather than what we asked for.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Seconds of life left. The only place Twitch tells us this after the
    /// grant, which is what makes renewing ahead of an expiry possible rather
    /// than only reacting to one -- and it beats storing a deadline of our
    /// own, which would be wrong on any machine whose clock has drifted or
    /// which was asleep across the interval.
    #[serde(default)]
    pub expires_in: u64,
}

#[derive(Debug)]
pub enum PollOutcome {
    Pending,
    Granted(Tokens),
    Failed(String),
}

pub async fn start_device(
    client: &reqwest::Client,
    client_id: &str,
    scopes: &str,
) -> Result<DeviceCode> {
    let response = client
        .post(DEVICE_URL)
        .form(&[("client_id", client_id), ("scopes", scopes)])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(anyhow!("Twitch rejected the device request ({status}): {body}"));
    }
    serde_json::from_str(&body)
        .map_err(|e| anyhow!("unexpected device response: {e} -- body was {body}"))
}

pub async fn poll_device(
    client: &reqwest::Client,
    client_id: &str,
    scopes: &str,
    device_code: &str,
) -> Result<PollOutcome> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("scopes", scopes),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if status.is_success() {
        return Ok(PollOutcome::Granted(serde_json::from_str(&body)?));
    }

    // Twitch reports "authorization_pending" while the user has not approved yet.
    // It signals this in the message field rather than a distinct status code.
    let lowered = body.to_ascii_lowercase();
    if lowered.contains("authorization_pending") || lowered.contains("pending") {
        return Ok(PollOutcome::Pending);
    }
    if lowered.contains("slow_down") {
        return Ok(PollOutcome::Pending);
    }
    Ok(PollOutcome::Failed(body))
}

/// How an attempt to trade a refresh token for a new one ended.
///
/// Refused and unreachable are different answers, and telling them apart is
/// the whole point: Twitch saying no means the grant is gone and no amount of
/// waiting brings it back, so the account may as well be dropped -- where a
/// timeout means we simply don't know yet, and the tokens we already hold are
/// very probably still good. Collapsing the two would sign everybody out the
/// first time a laptop woke up before its network did.
#[derive(Debug)]
pub enum RefreshOutcome {
    Renewed(Tokens),
    Rejected(String),
    Unreachable(String),
}

pub async fn refresh(
    client: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> RefreshOutcome {
    let response = match client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return RefreshOutcome::Unreachable(error.to_string()),
    };

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // A 4xx is Twitch telling us about the grant: the refresh token was
        // spent, revoked, or issued to a different Client ID. A 5xx is Twitch
        // having a bad day, which says nothing about what we hold.
        return if status.is_client_error() {
            RefreshOutcome::Rejected(format!("Twitch refused the refresh ({status}): {body}"))
        } else {
            RefreshOutcome::Unreachable(format!("Twitch answered {status}"))
        };
    }

    match serde_json::from_str(&body) {
        Ok(tokens) => RefreshOutcome::Renewed(tokens),
        // A success we can't parse is the one genuinely ambiguous case. Treat
        // it as unreachable: the cost of being wrong is one wasted retry,
        // against signing an account out over a response we misread.
        Err(error) => RefreshOutcome::Unreachable(format!("unexpected refresh response: {error}")),
    }
}

/// Confirms a stored token is still good and tells us which account it belongs to.
pub async fn validate(client: &reqwest::Client, token: &str) -> Result<Validation> {
    let response = client
        .get(VALIDATE_URL)
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn the_chat_scopes_are_requested_whatever_else_is_ticked() {
        let scopes = scope_string(&[]);
        for required in ["chat:read", "chat:edit", "user:write:chat"] {
            assert!(scopes.split(' ').any(|s| s == required), "{required} missing from {scopes}");
        }
    }

    #[test]
    fn a_ticked_group_adds_its_scopes() {
        let scopes = scope_string(&owned(&["moderation"]));
        assert!(scopes.contains("moderator:manage:banned_users"));
        // ...and nothing from the optional groups that weren't ticked.
        assert!(!scopes.contains("channel:manage:raids"));
    }

    #[test]
    fn an_unknown_group_is_ignored_rather_than_rejected() {
        // settings.json is hand-editable, and a stale group name from an older
        // build must not be able to stop someone signing in.
        assert_eq!(scope_string(&owned(&["nonsense"])), scope_string(&[]));
    }

    #[test]
    fn the_account_scopes_are_requested_whatever_else_is_ticked() {
        // Required rather than a ticked default: nothing here can reach a
        // channel, and a whisper that silently can't be sent is a bad way to
        // discover a box was unticked.
        assert!(scope_string(&[]).contains("user:manage:whispers"));
    }

    #[test]
    fn every_group_id_is_distinct() {
        let mut ids: Vec<&str> = PERMISSION_GROUPS.iter().map(|g| g.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }
}
