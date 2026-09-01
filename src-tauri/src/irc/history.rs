//! Recent chat history, for a backlog when you join a channel.
//!
//! Twitch offers no chat history to a third-party client -- their own site
//! reads it from an internal endpoint -- so this comes from
//! recent-messages.robotty.de, the open-source service Chatterino uses. It
//! runs a bot that joins the channels its users ask about and keeps the last
//! few hundred lines.
//!
//! What makes it cheap to use is the format: it answers with *raw IRC lines*,
//! tagged `historical=1`, so a backlog goes through exactly the same parser,
//! emote resolution and renderer as the live socket. Nothing here knows what a
//! message is.
//!
//! Two consequences worth being deliberate about. It's a volunteer-run third
//! party, so a failure is a non-event -- you get no backlog, not a broken join.
//! And asking it about a channel tells it you joined that channel, which is a
//! thing this app otherwise only tells Twitch.

use anyhow::Result;
use serde::Deserialize;

use crate::irc::parse::{self, IrcMessage};

const API: &str = "https://recent-messages.robotty.de/api/v2/recent-messages/";

/// How many lines to ask for. Enough to see what the channel was talking
/// about, well short of the 500 a channel's backlog holds.
const LIMIT: usize = 150;

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    messages: Vec<String>,
}

/// The lines worth replaying, oldest first, as the service sends them.
///
/// The response carries the channel's whole IRC traffic -- ROOMSTATE,
/// CLEARCHAT, NOTICE and the rest -- and only the ones that *are* a message
/// belong in a backlog. Filtering here rather than trusting `handle_line` with
/// them is deliberate: a historical ROOMSTATE would re-trigger the very asset
/// load that asked for this history.
fn playable(lines: Vec<String>) -> Vec<IrcMessage> {
    lines
        .iter()
        .filter_map(|line| parse::parse(line))
        .filter(|msg| matches!(msg.command.as_str(), "PRIVMSG" | "USERNOTICE"))
        .collect()
}

pub async fn fetch(client: &reqwest::Client, channel: &str) -> Result<Vec<IrcMessage>> {
    let response = client
        .get(format!("{API}{channel}"))
        .query(&[("limit", LIMIT.to_string())])
        .send()
        .await?
        .error_for_status()?
        .json::<Response>()
        .await?;
    Ok(playable(response.messages))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_response(json: &str) -> Vec<IrcMessage> {
        playable(serde_json::from_str::<Response>(json).unwrap().messages)
    }

    #[test]
    fn a_historical_privmsg_parses_like_any_other() {
        let json = r#"{"messages":["@rm-received-ts=1566417979914;historical=1;display-name=SomeUser;id=abc-123;tmi-sent-ts=1566417979900 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #pajlada :!braize"]}"#;
        let messages = parse_response(json);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text(), Some("!braize"));
        assert_eq!(messages[0].tag("display-name"), Some("SomeUser"));
        // The tag is what keeps a backlog from pinging on join.
        assert_eq!(messages[0].tag("historical"), Some("1"));
    }

    #[test]
    fn only_the_lines_that_are_a_message_are_replayed() {
        // A historical ROOMSTATE would re-trigger the asset load that asked
        // for this history; a NOTICE from an hour ago is noise.
        let json = r#"{"messages":[
            ":tmi.twitch.tv ROOMSTATE #forsen",
            "@id=1 :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hello",
            ":tmi.twitch.tv NOTICE #forsen :This room is now in slow mode.",
            "@msg-id=resub :tmi.twitch.tv USERNOTICE #forsen :nice",
            ":tmi.twitch.tv CLEARCHAT #forsen :someone"
        ]}"#;
        let commands: Vec<String> = parse_response(json).iter().map(|m| m.command.clone()).collect();
        assert_eq!(commands, ["PRIVMSG", "USERNOTICE"]);
    }

    #[test]
    fn the_order_the_service_sent_is_the_order_we_replay() {
        let json = r#"{"messages":[
            "@id=1 :a!a@a.tmi.twitch.tv PRIVMSG #forsen :first",
            "@id=2 :b!b@b.tmi.twitch.tv PRIVMSG #forsen :second"
        ]}"#;
        let messages = parse_response(json);
        let texts: Vec<Option<&str>> = messages.iter().map(|m| m.text()).collect();
        assert_eq!(texts, [Some("first"), Some("second")]);
    }

    #[test]
    fn a_line_that_doesnt_parse_is_skipped_rather_than_fatal() {
        let json = r#"{"messages":["", "not an irc line", "@id=1 :a!a@a PRIVMSG #forsen :hi"]}"#;
        assert_eq!(parse_response(json).len(), 1);
    }

    #[test]
    fn an_empty_or_absent_history_is_not_an_error() {
        assert!(parse_response(r#"{"messages":[]}"#).is_empty());
        assert!(parse_response("{}").is_empty());
    }
}
