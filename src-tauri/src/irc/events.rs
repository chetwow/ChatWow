//! Notices derived from IRC events that are available to every chat reader.
use super::parse::IrcMessage;
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct RoomSettings {
    initialized: bool,
    values: HashMap<&'static str, i64>,
}

impl RoomSettings {
    /// ROOMSTATE on join is a snapshot; later frames contain only changed tags.
    pub fn update(&mut self, msg: &IrcMessage) -> Vec<String> {
        let mut notices = Vec::new();
        for (tag, label) in [
            ("subs-only", "Subscribers-only mode"),
            ("emote-only", "Emote-only mode"),
            ("r9k", "Unique-chat mode"),
            ("slow", "Slow mode"),
            ("followers-only", "Followers-only mode"),
        ] {
            let Some(value) = msg.tag(tag).and_then(|v| v.parse::<i64>().ok()) else {
                continue;
            };
            if (tag == "followers-only" && value < -1) || (tag != "followers-only" && value < 0) {
                continue;
            }
            let previous = self.values.insert(tag, value);
            if !self.initialized || previous == Some(value) {
                continue;
            }
            let detail = match tag {
                "slow" if value > 0 => format!("enabled ({value} seconds)"),
                "followers-only" if value >= 0 => format!("enabled ({value} minutes)"),
                "followers-only" => "disabled".to_string(),
                _ if value > 0 => "enabled".to_string(),
                _ => "disabled".to_string(),
            };
            notices.push(format!("{label} {detail}."));
        }
        self.initialized = true;
        notices
    }
}

pub fn moderation_text(msg: &IrcMessage) -> Option<String> {
    Some(match msg.command.as_str() {
        "CLEARCHAT" => match msg.text().filter(|login| !login.is_empty()) {
            Some(login) => match msg.tag("ban-duration").and_then(|v| v.parse::<u64>().ok()) {
                Some(seconds) => format!("{login} was timed out for {seconds} seconds."),
                None => format!("{login} was banned."),
            },
            None => "Chat was cleared by a moderator.".to_string(),
        },
        "CLEARMSG" => match msg.tag("login") {
            Some(login) => format!("A message from {login} was deleted by a moderator."),
            None => "A message was deleted by a moderator.".to_string(),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::super::parse::parse;
    use super::*;

    #[test]
    fn room_updates_are_partial_and_the_join_snapshot_is_silent() {
        let mut room = RoomSettings::default();
        let parse_modes = |tags| parse(&format!("@{tags} :tmi.twitch.tv ROOMSTATE #room")).unwrap();
        assert!(room
            .update(&parse_modes("subs-only=0;slow=0;followers-only=-1"))
            .is_empty());
        assert_eq!(
            room.update(&parse_modes("subs-only=1")),
            ["Subscribers-only mode enabled."]
        );
        assert!(room.update(&parse_modes("subs-only=1")).is_empty());
        assert_eq!(
            room.update(&parse_modes("slow=10;followers-only=0")),
            [
                "Slow mode enabled (10 seconds).",
                "Followers-only mode enabled (0 minutes)."
            ]
        );
        assert_eq!(
            room.update(&parse_modes("slow=0;followers-only=-1;subs-only=0")),
            [
                "Subscribers-only mode disabled.",
                "Slow mode disabled.",
                "Followers-only mode disabled."
            ]
        );
        assert!(room
            .update(&parse_modes("slow=bad;followers-only=-9"))
            .is_empty());
    }

    #[test]
    fn moderation_notices_do_not_repeat_deleted_message_contents() {
        for (raw, expected) in [
            (
                ":tmi.twitch.tv CLEARCHAT #room :viewer",
                "viewer was banned.",
            ),
            (
                "@ban-duration=60 :tmi.twitch.tv CLEARCHAT #room :viewer",
                "viewer was timed out for 60 seconds.",
            ),
            (
                ":tmi.twitch.tv CLEARCHAT #room",
                "Chat was cleared by a moderator.",
            ),
            (
                "@login=viewer :tmi.twitch.tv CLEARMSG #room :private body",
                "A message from viewer was deleted by a moderator.",
            ),
        ] {
            assert_eq!(
                moderation_text(&parse(raw).unwrap()).as_deref(),
                Some(expected)
            );
        }
    }
}
