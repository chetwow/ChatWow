//! IRCv3 line parser for the Twitch chat protocol.
//!
//! Twitch sends lines shaped like:
//!   @tag=value;tag2=value :nick!user@host COMMAND #channel :trailing text

use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IrcMessage {
    pub tags: HashMap<String, String>,
    pub prefix: Option<String>,
    pub command: String,
    pub params: Vec<String>,
}

impl IrcMessage {
    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags
            .get(key)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }

    /// The nickname portion of the prefix (`nick!user@host` -> `nick`).
    pub fn nick(&self) -> Option<&str> {
        let prefix = self.prefix.as_deref()?;
        Some(prefix.split(['!', '@']).next().unwrap_or(prefix))
    }

    /// First parameter with the leading `#` stripped, lowercased.
    pub fn channel(&self) -> Option<String> {
        let p = self.params.first()?;
        Some(p.trim_start_matches('#').to_ascii_lowercase())
    }

    /// The trailing parameter, which for PRIVMSG is the message body.
    pub fn text(&self) -> Option<&str> {
        self.params.get(1).map(|s| s.as_str())
    }
}

/// What our own USERSTATE says we are in a channel.
///
/// Twitch sends one on join and after each message we send, and it's the only
/// place a plain chat client learns whether it can moderate here -- there's no
/// Helix endpoint that answers "am I a mod in someone else's channel". The
/// broadcaster's own USERSTATE has `mod=0`, so the badge is what tells us.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChannelRole {
    pub moderator: bool,
    pub broadcaster: bool,
}

impl ChannelRole {
    pub fn of(msg: &IrcMessage) -> Self {
        let badges = msg.tag("badges").unwrap_or_default();
        let broadcaster = badges
            .split(',')
            .any(|badge| badge.starts_with("broadcaster/"));
        Self {
            // The broadcaster can do everything a moderator can, and Twitch
            // doesn't bother saying so on their own USERSTATE.
            moderator: broadcaster || msg.tag("mod") == Some("1"),
            broadcaster,
        }
    }
}

/// Undo IRCv3 tag value escaping. A trailing lone backslash is dropped, per spec.
fn unescape_tag(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

pub fn parse(line: &str) -> Option<IrcMessage> {
    let mut rest = line.trim_end_matches(['\r', '\n']);
    if rest.is_empty() {
        return None;
    }

    let mut msg = IrcMessage::default();

    if let Some(stripped) = rest.strip_prefix('@') {
        let (tags, remainder) = stripped.split_once(' ')?;
        for pair in tags.split(';') {
            if pair.is_empty() {
                continue;
            }
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            msg.tags.insert(key.to_string(), unescape_tag(value));
        }
        rest = remainder;
    }

    rest = rest.trim_start();

    if let Some(stripped) = rest.strip_prefix(':') {
        let (prefix, remainder) = stripped.split_once(' ')?;
        msg.prefix = Some(prefix.to_string());
        rest = remainder.trim_start();
    }

    let (command, remainder) = match rest.split_once(' ') {
        Some((c, r)) => (c, r.trim_start()),
        None => (rest, ""),
    };
    if command.is_empty() {
        return None;
    }
    msg.command = command.to_ascii_uppercase();

    let mut params_src = remainder;
    while !params_src.is_empty() {
        if let Some(trailing) = params_src.strip_prefix(':') {
            msg.params.push(trailing.to_string());
            break;
        }
        match params_src.split_once(' ') {
            Some((param, remaining)) => {
                msg.params.push(param.to_string());
                params_src = remaining.trim_start();
            }
            None => {
                msg.params.push(params_src.to_string());
                break;
            }
        }
    }

    Some(msg)
}

/// Twitch sends `/me` messages wrapped in the CTCP ACTION envelope.
pub fn strip_action(text: &str) -> (bool, &str) {
    if let Some(inner) = text.strip_prefix("\u{1}ACTION ") {
        (true, inner.strip_suffix('\u{1}').unwrap_or(inner))
    } else {
        (false, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moderators_userstate_reads_as_a_moderator() {
        let line =
            "@badges=moderator/1;display-name=Someone;mod=1 :tmi.twitch.tv USERSTATE #forsen";
        let role = ChannelRole::of(&parse(line).unwrap());
        assert!(role.moderator);
        assert!(!role.broadcaster);
    }

    #[test]
    fn a_broadcaster_counts_as_a_moderator_in_their_own_channel() {
        // Twitch sends the broadcaster mod=0 -- the badge is the only signal.
        let line = "@badges=broadcaster/1,subscriber/12;mod=0 :tmi.twitch.tv USERSTATE #forsen";
        let role = ChannelRole::of(&parse(line).unwrap());
        assert!(role.broadcaster);
        assert!(
            role.moderator,
            "the broadcaster can run everything a mod can"
        );
    }

    #[test]
    fn an_ordinary_viewer_is_neither() {
        let line = "@badges=subscriber/12,premium/1;mod=0 :tmi.twitch.tv USERSTATE #forsen";
        let role = ChannelRole::of(&parse(line).unwrap());
        assert!(!role.moderator);
        assert!(!role.broadcaster);
    }

    #[test]
    fn a_userstate_with_no_badges_at_all_is_not_an_error() {
        let role = ChannelRole::of(&parse(":tmi.twitch.tv USERSTATE #forsen").unwrap());
        assert_eq!(role, ChannelRole::default());
    }

    #[test]
    fn a_badge_that_merely_starts_the_same_way_is_not_the_broadcaster() {
        // Guards the prefix match: only "broadcaster/<version>" counts.
        let line = "@badges=broadcaster-elect/1;mod=0 :tmi.twitch.tv USERSTATE #forsen";
        assert!(!ChannelRole::of(&parse(line).unwrap()).broadcaster);
    }

    #[test]
    fn parses_a_real_privmsg() {
        let line = "@badge-info=subscriber/14;badges=subscriber/12,premium/1;color=#1E90FF;display-name=SomeUser;emotes=25:0-4;id=abc-123;room-id=71092938;tmi-sent-ts=1700000000000;user-id=1234 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #forsen :Kappa hello world";
        let msg = parse(line).expect("should parse");
        assert_eq!(msg.command, "PRIVMSG");
        assert_eq!(msg.nick(), Some("someuser"));
        assert_eq!(msg.channel().as_deref(), Some("forsen"));
        assert_eq!(msg.text(), Some("Kappa hello world"));
        assert_eq!(msg.tag("color"), Some("#1E90FF"));
        assert_eq!(msg.tag("emotes"), Some("25:0-4"));
        assert_eq!(msg.tag("room-id"), Some("71092938"));
    }

    #[test]
    fn unescapes_spaces_in_tag_values() {
        // system-msg is the tag that actually carries escaped spaces in the wild.
        let line = "@system-msg=Some\\sUser\\ssubscribed\\sat\\sTier\\s1.;msg-id=resub :tmi.twitch.tv USERNOTICE #chan :body";
        let msg = parse(line).unwrap();
        assert_eq!(
            msg.tag("system-msg"),
            Some("Some User subscribed at Tier 1.")
        );
        assert_eq!(msg.tag("msg-id"), Some("resub"));
    }

    #[test]
    fn unescapes_semicolons_and_backslashes() {
        // Raw line is:  @a=x\:y;b=p\\q;c=trailing\
        let msg = parse("@a=x\\:y;b=p\\\\q;c=trailing\\ :tmi.twitch.tv NOTICE #c :hi").unwrap();
        assert_eq!(msg.tag("a"), Some("x;y"));
        assert_eq!(msg.tag("b"), Some("p\\q"));
        assert_eq!(msg.tag("c"), Some("trailing"));
    }

    #[test]
    fn empty_tag_values_read_as_none() {
        let msg = parse("@color=;display-name=Bob :b!b@b PRIVMSG #c :yo").unwrap();
        assert_eq!(msg.tag("color"), None);
        assert_eq!(msg.tag("display-name"), Some("Bob"));
    }

    #[test]
    fn parses_ping_without_tags_or_prefix() {
        let msg = parse("PING :tmi.twitch.tv").unwrap();
        assert_eq!(msg.command, "PING");
        assert_eq!(msg.params, vec!["tmi.twitch.tv".to_string()]);
        assert_eq!(msg.prefix, None);
    }

    #[test]
    fn parses_message_containing_colons() {
        let msg = parse(":u!u@u PRIVMSG #c :hey: check https://example.com/a:b").unwrap();
        assert_eq!(msg.text(), Some("hey: check https://example.com/a:b"));
    }

    #[test]
    fn parses_clearchat_timeout() {
        let msg = parse(
            "@ban-duration=600;room-id=1;target-user-id=99 :tmi.twitch.tv CLEARCHAT #chan :baduser",
        )
        .unwrap();
        assert_eq!(msg.command, "CLEARCHAT");
        assert_eq!(msg.tag("ban-duration"), Some("600"));
        assert_eq!(msg.text(), Some("baduser"));
    }

    #[test]
    fn detects_ctcp_action() {
        let (is_action, body) = strip_action("\u{1}ACTION waves\u{1}");
        assert!(is_action);
        assert_eq!(body, "waves");
        let (is_action, body) = strip_action("plain text");
        assert!(!is_action);
        assert_eq!(body, "plain text");
    }

    #[test]
    fn empty_trailing_param_is_preserved() {
        let msg = parse(":u!u@u PRIVMSG #c :").unwrap();
        assert_eq!(msg.text(), Some(""));
    }
}
