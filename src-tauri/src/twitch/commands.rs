//! Twitch chat commands.
//!
//! Twitch stopped accepting chat commands over IRC in 2023 -- sending
//! "/ban someone" as a PRIVMSG posts those eleven characters as a message.
//! Every command is a Helix call now, so this module is the whole mapping:
//! command word to endpoint, arguments to query and body, response to the one
//! line worth printing back into chat.
//!
//! Only the *execution* lives here. What the command picker shows -- usage,
//! description, which permission a command needs -- is in `src/lib/commands.ts`
//! on the frontend, for the same reason mentions and emote blacklists are: it
//! depends on the granted scopes, which change on sign-in without anything
//! being rebuilt, and the picker has to answer for every keystroke without a
//! round trip. Twitch is the final word either way; a command the picker got
//! wrong fails here with Twitch's own explanation.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use super::helix::Helix;
use super::users;

pub struct Context<'a> {
    pub helix: &'a Helix<'a>,
    /// The channel the command was typed in.
    pub channel: &'a str,
    /// That channel's broadcaster id, from ROOMSTATE's `room-id`.
    pub broadcaster_id: &'a str,
    /// Our own user id: the `moderator_id` or `sender_id` on every call.
    pub user_id: &'a str,
}

/// The command word (lowercased, no slash) and everything after it.
///
/// Returns `None` for anything that isn't a command, so plain text and a bare
/// "/" both fall through to being sent as a message.
pub fn split_command(input: &str) -> Option<(String, &str)> {
    let rest = input.trim_start().strip_prefix('/')?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (name, args) = rest.split_at(end);
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((name.to_ascii_lowercase(), args.trim()))
}

/// The first whitespace-separated word, and the remainder with its leading
/// space eaten -- so a reason keeps its own internal spacing.
fn next_word(args: &str) -> (&str, &str) {
    let args = args.trim_start();
    match args.find(char::is_whitespace) {
        Some(end) => (&args[..end], args[end..].trim_start()),
        None => (args, ""),
    }
}

/// A user argument, however it was typed. Chat writes names with an `@` and
/// in whatever case the display name uses; Twitch matches logins.
fn normalize_login(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_ascii_lowercase()
}

/// Pull a leading user argument off, or fail with the command's usage.
fn user_arg<'a>(args: &'a str, usage: &str) -> Result<(String, &'a str)> {
    let (first, rest) = next_word(args);
    let login = normalize_login(first);
    if login.is_empty() {
        bail!("Usage: {usage}");
    }
    Ok((login, rest))
}

/// A length written the way chat writes it: bare seconds, or a number with a
/// unit (`10m`, `1h`, `7d`). `None` for anything else, so a typo'd duration
/// stops the command instead of silently becoming a different one.
pub fn parse_duration_secs(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
    let (digits, unit) = text.split_at(split);
    let value: u64 = digits.parse().ok()?;
    let multiplier = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600,
        "d" | "day" | "days" => 86_400,
        "w" | "week" | "weeks" => 604_800,
        _ => return None,
    };
    value.checked_mul(multiplier)
}

/// Follower mode is the one length Twitch measures in minutes, and its chat
/// command has always taken a bare number as minutes rather than seconds.
fn parse_minutes(text: &str) -> Option<u64> {
    let text = text.trim();
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) {
        return text.parse().ok();
    }
    parse_duration_secs(text).map(|secs| secs / 60)
}

/// Commands whose Helix endpoint acts on *your* channel rather than the one
/// you typed in. Run in someone else's chat they'd either be rejected with a
/// cryptic id mismatch or -- for a raid -- quietly do the right thing to the
/// wrong channel, so they're stopped here with a sentence that explains it.
fn require_broadcaster(ctx: &Context<'_>, name: &str) -> Result<()> {
    if ctx.broadcaster_id != ctx.user_id {
        bail!("/{name} only works in your own channel, not #{}", ctx.channel);
    }
    Ok(())
}

/// The `user_name`s in a Helix list response, in the order Twitch gave them.
fn user_names(response: &Value) -> Vec<String> {
    response["data"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["user_name"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// One chat-settings toggle. Every mode command is this call with a different
/// field, and Twitch leaves anything the body omits alone.
async fn chat_settings(ctx: &Context<'_>, patch: Value) -> Result<()> {
    ctx.helix
        .patch(
            "chat/settings",
            &[("broadcaster_id", ctx.broadcaster_id), ("moderator_id", ctx.user_id)],
            patch,
        )
        .await?;
    Ok(())
}

/// Ban or time out -- one endpoint, distinguished by whether there's a duration.
async fn ban(ctx: &Context<'_>, login: &str, duration: Option<u64>, reason: &str) -> Result<()> {
    let target = users::lookup_id(ctx.helix, login).await?;
    let mut data = json!({ "user_id": target });
    if let Some(seconds) = duration {
        data["duration"] = json!(seconds);
    }
    if !reason.is_empty() {
        data["reason"] = json!(reason);
    }
    ctx.helix
        .post(
            "moderation/bans",
            &[("broadcaster_id", ctx.broadcaster_id), ("moderator_id", ctx.user_id)],
            Some(json!({ "data": data })),
        )
        .await?;
    Ok(())
}

/// Run one command. `Ok` is the line to print into the channel; `Err` is
/// shown against the composer with the text still in it, so a mistyped
/// argument can be fixed rather than retyped.
pub async fn run(ctx: &Context<'_>, name: &str, args: &str) -> Result<String> {
    let helix = ctx.helix;
    let broadcaster = ctx.broadcaster_id;
    let us = ctx.user_id;

    match name {
        "ban" => {
            let (login, reason) = user_arg(args, "/ban <user> [reason]")?;
            ban(ctx, &login, None, reason).await?;
            Ok(format!("Banned {login}."))
        }

        "timeout" => {
            let (login, rest) = user_arg(args, "/timeout <user> [duration] [reason]")?;
            // The duration is optional and the reason is free text, so a first
            // word that doesn't parse as a length is the start of the reason.
            let (maybe_duration, tail) = next_word(rest);
            let (seconds, reason) = match parse_duration_secs(maybe_duration) {
                Some(seconds) => (seconds, tail),
                None => (600, rest),
            };
            ban(ctx, &login, Some(seconds), reason).await?;
            Ok(format!("Timed out {login} for {seconds}s."))
        }

        "unban" | "untimeout" => {
            let (login, _) = user_arg(args, "/unban <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .delete(
                    "moderation/bans",
                    &[
                        ("broadcaster_id", broadcaster),
                        ("moderator_id", us),
                        ("user_id", &target),
                    ],
                )
                .await?;
            Ok(format!("Lifted the ban or timeout on {login}."))
        }

        "warn" => {
            let (login, reason) = user_arg(args, "/warn <user> <reason>")?;
            if reason.is_empty() {
                bail!("Usage: /warn <user> <reason> -- Twitch requires a reason");
            }
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post(
                    "moderation/warnings",
                    &[("broadcaster_id", broadcaster), ("moderator_id", us)],
                    Some(json!({ "data": { "user_id": target, "reason": reason } })),
                )
                .await?;
            Ok(format!("Warned {login}."))
        }

        "clear" => {
            helix
                .delete(
                    "moderation/chat",
                    &[("broadcaster_id", broadcaster), ("moderator_id", us)],
                )
                .await?;
            Ok("Cleared the chat.".to_string())
        }

        "delete" => {
            let (id, _) = next_word(args);
            if id.is_empty() {
                bail!("Usage: /delete <message-id>");
            }
            helix
                .delete(
                    "moderation/chat",
                    &[
                        ("broadcaster_id", broadcaster),
                        ("moderator_id", us),
                        ("message_id", id),
                    ],
                )
                .await?;
            Ok("Deleted that message.".to_string())
        }

        "slow" => {
            let seconds = match next_word(args).0 {
                "" => 30,
                given => parse_duration_secs(given)
                    .ok_or_else(|| anyhow!("Usage: /slow [duration] -- e.g. 30 or 1m"))?,
            };
            chat_settings(ctx, json!({ "slow_mode": true, "slow_mode_wait_time": seconds })).await?;
            Ok(format!("Slow mode on, {seconds}s between messages."))
        }
        "slowoff" => {
            chat_settings(ctx, json!({ "slow_mode": false })).await?;
            Ok("Slow mode off.".to_string())
        }

        "followers" => {
            let minutes = match next_word(args).0 {
                "" => 0,
                given => parse_minutes(given)
                    .ok_or_else(|| anyhow!("Usage: /followers [duration] -- e.g. 10m or 30"))?,
            };
            chat_settings(
                ctx,
                json!({ "follower_mode": true, "follower_mode_duration": minutes }),
            )
            .await?;
            Ok(match minutes {
                0 => "Followers-only mode on.".to_string(),
                minutes => format!("Followers-only mode on, {minutes} minutes of following required."),
            })
        }
        "followersoff" => {
            chat_settings(ctx, json!({ "follower_mode": false })).await?;
            Ok("Followers-only mode off.".to_string())
        }

        "subscribers" => {
            chat_settings(ctx, json!({ "subscriber_mode": true })).await?;
            Ok("Subscribers-only mode on.".to_string())
        }
        "subscribersoff" => {
            chat_settings(ctx, json!({ "subscriber_mode": false })).await?;
            Ok("Subscribers-only mode off.".to_string())
        }

        "emoteonly" => {
            chat_settings(ctx, json!({ "emote_mode": true })).await?;
            Ok("Emote-only mode on.".to_string())
        }
        "emoteonlyoff" => {
            chat_settings(ctx, json!({ "emote_mode": false })).await?;
            Ok("Emote-only mode off.".to_string())
        }

        // r9kbeta is what this mode was called for years; Twitch renamed it to
        // unique chat and kept both command names working.
        "uniquechat" | "r9kbeta" => {
            chat_settings(ctx, json!({ "unique_chat_mode": true })).await?;
            Ok("Unique-chat mode on.".to_string())
        }
        "uniquechatoff" | "r9kbetaoff" => {
            chat_settings(ctx, json!({ "unique_chat_mode": false })).await?;
            Ok("Unique-chat mode off.".to_string())
        }

        "announce" | "announceblue" | "announcegreen" | "announceorange" | "announcepurple" => {
            if args.is_empty() {
                bail!("Usage: /{name} <message>");
            }
            let color = name.strip_prefix("announce").filter(|c| !c.is_empty()).unwrap_or("primary");
            helix
                .post(
                    "chat/announcements",
                    &[("broadcaster_id", broadcaster), ("moderator_id", us)],
                    Some(json!({ "message": args, "color": color })),
                )
                .await?;
            Ok("Announced.".to_string())
        }

        "shoutout" => {
            let (login, _) = user_arg(args, "/shoutout <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post(
                    "chat/shoutouts",
                    &[
                        ("from_broadcaster_id", broadcaster),
                        ("to_broadcaster_id", &target),
                        ("moderator_id", us),
                    ],
                    None,
                )
                .await?;
            Ok(format!("Shouted out {login}."))
        }

        "mod" => {
            require_broadcaster(ctx, name)?;
            let (login, _) = user_arg(args, "/mod <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post(
                    "moderation/moderators",
                    &[("broadcaster_id", broadcaster), ("user_id", &target)],
                    None,
                )
                .await?;
            Ok(format!("{login} is now a moderator."))
        }
        "unmod" => {
            require_broadcaster(ctx, name)?;
            let (login, _) = user_arg(args, "/unmod <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .delete(
                    "moderation/moderators",
                    &[("broadcaster_id", broadcaster), ("user_id", &target)],
                )
                .await?;
            Ok(format!("{login} is no longer a moderator."))
        }
        "mods" => {
            require_broadcaster(ctx, name)?;
            let response = helix
                .get("moderation/moderators", &[("broadcaster_id", broadcaster), ("first", "100")])
                .await?;
            let names = user_names(&response);
            Ok(match names.len() {
                0 => "You have no moderators.".to_string(),
                _ => format!("Moderators ({}): {}", names.len(), names.join(", ")),
            })
        }

        "vip" => {
            require_broadcaster(ctx, name)?;
            let (login, _) = user_arg(args, "/vip <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post("channels/vips", &[("broadcaster_id", broadcaster), ("user_id", &target)], None)
                .await?;
            Ok(format!("{login} is now a VIP."))
        }
        "unvip" => {
            require_broadcaster(ctx, name)?;
            let (login, _) = user_arg(args, "/unvip <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .delete("channels/vips", &[("broadcaster_id", broadcaster), ("user_id", &target)])
                .await?;
            Ok(format!("{login} is no longer a VIP."))
        }
        "vips" => {
            require_broadcaster(ctx, name)?;
            let response = helix
                .get("channels/vips", &[("broadcaster_id", broadcaster), ("first", "100")])
                .await?;
            let names = user_names(&response);
            Ok(match names.len() {
                0 => "You have no VIPs.".to_string(),
                _ => format!("VIPs ({}): {}", names.len(), names.join(", ")),
            })
        }

        "raid" => {
            require_broadcaster(ctx, name)?;
            let (login, _) = user_arg(args, "/raid <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post(
                    "raids",
                    &[("from_broadcaster_id", us), ("to_broadcaster_id", &target)],
                    None,
                )
                .await?;
            Ok(format!("Raiding {login} -- Twitch runs the ten-second countdown."))
        }
        "unraid" => {
            require_broadcaster(ctx, name)?;
            helix.delete("raids", &[("broadcaster_id", us)]).await?;
            Ok("Cancelled the raid.".to_string())
        }

        "commercial" => {
            require_broadcaster(ctx, name)?;
            let seconds = match next_word(args).0 {
                "" => 30,
                given => parse_duration_secs(given)
                    .ok_or_else(|| anyhow!("Usage: /commercial [length] -- 30, 60, 90, 120, 150 or 180"))?,
            };
            helix
                .post(
                    "channels/commercial",
                    &[],
                    Some(json!({ "broadcaster_id": broadcaster, "length": seconds })),
                )
                .await?;
            Ok(format!("Started a {seconds}s commercial."))
        }

        "marker" => {
            let mut body = json!({ "user_id": broadcaster });
            if !args.is_empty() {
                body["description"] = json!(args);
            }
            helix.post("streams/markers", &[], Some(body)).await?;
            Ok("Marked the stream.".to_string())
        }

        "color" => {
            let (color, _) = next_word(args);
            if color.is_empty() {
                bail!("Usage: /color <color> -- a named color, or a hex code with Turbo or Prime");
            }
            helix.put("chat/color", &[("user_id", us), ("color", color)]).await?;
            Ok(format!("Your name color is now {color}."))
        }

        "block" => {
            let (login, _) = user_arg(args, "/block <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix.put("users/blocks", &[("target_user_id", &target)]).await?;
            Ok(format!("Blocked {login}."))
        }
        "unblock" => {
            let (login, _) = user_arg(args, "/unblock <user>")?;
            let target = users::lookup_id(helix, &login).await?;
            helix.delete("users/blocks", &[("target_user_id", &target)]).await?;
            Ok(format!("Unblocked {login}."))
        }

        "w" | "whisper" => {
            let (login, message) = user_arg(args, "/w <user> <message>")?;
            if message.is_empty() {
                bail!("Usage: /w <user> <message>");
            }
            let target = users::lookup_id(helix, &login).await?;
            helix
                .post(
                    "whispers",
                    &[("from_user_id", us), ("to_user_id", &target)],
                    Some(json!({ "message": message })),
                )
                .await?;
            Ok(format!("Whispered {login}."))
        }

        _ => bail!("Unknown command: /{name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_splits_into_its_name_and_the_rest() {
        let (name, args) = split_command("/timeout forsen 10m being rude").unwrap();
        assert_eq!(name, "timeout");
        assert_eq!(args, "forsen 10m being rude");
    }

    #[test]
    fn command_names_are_matched_case_insensitively() {
        assert_eq!(split_command("/Clear").unwrap().0, "clear");
    }

    #[test]
    fn plain_text_is_never_a_command() {
        assert!(split_command("hello chat").is_none());
        assert!(split_command("2/3 of the way").is_none());
        // A bare slash, and the "//" people type by accident: both are text.
        assert!(split_command("/").is_none());
        assert!(split_command("//").is_none());
    }

    #[test]
    fn a_command_with_no_arguments_has_empty_args() {
        let (name, args) = split_command("/mods").unwrap();
        assert_eq!(name, "mods");
        assert_eq!(args, "");
    }

    #[test]
    fn a_user_argument_survives_an_at_sign_and_capitals() {
        let (login, rest) = user_arg("@Forsen spamming", "/ban <user> [reason]").unwrap();
        assert_eq!(login, "forsen");
        assert_eq!(rest, "spamming");
    }

    #[test]
    fn a_missing_user_argument_is_answered_with_the_usage() {
        let error = user_arg("", "/ban <user> [reason]").unwrap_err();
        assert_eq!(error.to_string(), "Usage: /ban <user> [reason]");
    }

    #[test]
    fn a_reason_keeps_its_own_spacing() {
        let (_, reason) = user_arg("forsen  said  something", "/ban <user>").unwrap();
        assert_eq!(reason, "said  something");
    }

    #[test]
    fn durations_are_read_the_way_chat_writes_them() {
        assert_eq!(parse_duration_secs("600"), Some(600));
        assert_eq!(parse_duration_secs("10m"), Some(600));
        assert_eq!(parse_duration_secs("1h"), Some(3_600));
        assert_eq!(parse_duration_secs("7d"), Some(604_800));
        assert_eq!(parse_duration_secs("2 weeks"), Some(1_209_600));
    }

    #[test]
    fn a_duration_that_isnt_one_is_rejected_rather_than_guessed() {
        // This is what tells "/timeout user 10m rude" from "/timeout user rude":
        // a first word that isn't a length is the start of the reason.
        assert_eq!(parse_duration_secs("rude"), None);
        assert_eq!(parse_duration_secs(""), None);
        assert_eq!(parse_duration_secs("10x"), None);
        assert_eq!(parse_duration_secs("m"), None);
    }

    #[test]
    fn an_absurd_duration_overflows_to_none_rather_than_wrapping() {
        assert_eq!(parse_duration_secs("99999999999999999999w"), None);
    }

    #[test]
    fn follower_mode_reads_a_bare_number_as_minutes() {
        // Its chat command always has, unlike every other duration here.
        assert_eq!(parse_minutes("30"), Some(30));
        assert_eq!(parse_minutes("2h"), Some(120));
        assert_eq!(parse_minutes("nope"), None);
    }

    #[test]
    fn broadcaster_only_commands_name_the_channel_they_wont_run_in() {
        let client = reqwest::Client::new();
        let helix = Helix { client: &client, client_id: "id", token: "token" };
        let ctx = Context {
            helix: &helix,
            channel: "forsen",
            broadcaster_id: "22484632",
            user_id: "1234",
        };
        let error = require_broadcaster(&ctx, "raid").unwrap_err();
        assert_eq!(error.to_string(), "/raid only works in your own channel, not #forsen");
    }

    #[test]
    fn a_broadcaster_in_their_own_channel_passes_the_gate() {
        let client = reqwest::Client::new();
        let helix = Helix { client: &client, client_id: "id", token: "token" };
        let ctx = Context {
            helix: &helix,
            channel: "me",
            broadcaster_id: "1234",
            user_id: "1234",
        };
        assert!(require_broadcaster(&ctx, "raid").is_ok());
    }

    #[test]
    fn a_list_response_reads_back_as_display_names() {
        let response = serde_json::json!({
            "data": [{"user_name": "Forsen"}, {"user_name": "NymN"}]
        });
        assert_eq!(user_names(&response), vec!["Forsen", "NymN"]);
    }

    #[test]
    fn an_empty_list_response_is_not_an_error() {
        assert!(user_names(&serde_json::json!({ "data": [] })).is_empty());
        assert!(user_names(&serde_json::json!({})).is_empty());
    }
}
