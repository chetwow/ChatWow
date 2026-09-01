//! Turns a parsed IRC message into the fully-resolved payload the UI renders.
//!
//! Doing this in Rust keeps two fiddly things in one tested place: Twitch's
//! emote ranges are indexed by Unicode *code point* (not bytes, not UTF-16
//! units), and 7TV overlay emotes have to be folded onto the emote before them.

use serde::Serialize;
use std::collections::HashMap;

use crate::color;
use crate::emotes::{twitch_emote, Emote};
use crate::irc::parse::{strip_action, IrcMessage};
use crate::twitch::badges::{Badge, BadgeMap};

#[derive(Debug, Clone, Serialize)]
pub struct Overlay {
    pub id: String,
    pub name: String,
    pub url: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Segment {
    Text {
        text: String,
    },
    Emote {
        id: String,
        name: String,
        url: String,
        url_large: String,
        provider: String,
        /// Overlay emotes stacked on top of this one.
        overlays: Vec<Overlay>,
    },
    Mention {
        text: String,
    },
    Link {
        text: String,
        href: String,
    },
}

/// The message a reply is quoting. Carried by the reply itself -- Twitch
/// sends the parent's login/display-name/body as tags on the child PRIVMSG
/// rather than expecting clients to look the parent up locally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyInfo {
    pub login: String,
    pub display_name: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub channel: String,
    pub ts: i64,
    pub login: String,
    pub display_name: String,
    pub color: String,
    pub badges: Vec<Badge>,
    pub segments: Vec<Segment>,
    pub is_action: bool,
    pub is_first_message: bool,
    /// "chat" | "system" | "notice" | "whisper"
    pub kind: String,
    /// Replayed from the history service on join rather than received live.
    /// The frontend uses it to keep a backlog from pinging or counting as
    /// unread -- it isn't news, however recently it was said.
    pub historical: bool,
    pub system_message: Option<String>,
    pub reply_to: Option<ReplyInfo>,
}

/// Emote lookup for one channel: channel set shadows the global set.
pub struct EmoteLookup<'a> {
    pub channel: Option<&'a HashMap<String, Emote>>,
    pub global: &'a HashMap<String, Emote>,
}

impl<'a> EmoteLookup<'a> {
    fn get(&self, name: &str) -> Option<&Emote> {
        self.channel
            .and_then(|m| m.get(name))
            .or_else(|| self.global.get(name))
    }
}

/// Badge lookup for one channel: channel badges (sub tiers, bits) shadow global.
pub struct BadgeLookup<'a> {
    pub channel: Option<&'a BadgeMap>,
    pub global: &'a BadgeMap,
}

impl<'a> BadgeLookup<'a> {
    fn get(&self, set_id: &str, version: &str) -> Option<&Badge> {
        let key = (set_id.to_string(), version.to_string());
        self.channel
            .and_then(|m| m.get(&key))
            .or_else(|| self.global.get(&key))
    }
}

/// Intermediate node list, before overlays are folded in.
#[derive(Debug, Clone)]
enum Node {
    Text(String),
    Emote(Emote, Vec<Overlay>),
    Mention(String),
    Link(String),
}

/// Parse the `emotes` tag: `25:0-4,12-16/1902:6-10`
/// Returns (start, end_inclusive, emote_id) sorted by start.
fn parse_emote_ranges(tag: &str) -> Vec<(usize, usize, String)> {
    let mut ranges = Vec::new();
    for group in tag.split('/').filter(|g| !g.is_empty()) {
        let Some((id, positions)) = group.split_once(':') else { continue };
        for position in positions.split(',').filter(|p| !p.is_empty()) {
            let Some((start, end)) = position.split_once('-') else { continue };
            let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) else {
                continue;
            };
            if end >= start {
                ranges.push((start, end, id.to_string()));
            }
        }
    }
    ranges.sort_by_key(|(start, _, _)| *start);
    ranges
}

fn is_link(token: &str) -> bool {
    token.starts_with("http://") || token.starts_with("https://")
}

fn is_mention(token: &str) -> bool {
    token.len() > 1 && token.starts_with('@')
}

/// Split plain text into nodes, promoting 7TV emotes, links and mentions.
fn tokenize(text: &str, emotes: &EmoteLookup, out: &mut Vec<Node>) {
    if text.is_empty() {
        return;
    }
    let mut buffer = String::new();
    for (index, token) in text.split(' ').enumerate() {
        if index > 0 {
            buffer.push(' ');
        }
        if token.is_empty() {
            continue;
        }

        if let Some(emote) = emotes.get(token) {
            flush(&mut buffer, out);
            out.push(Node::Emote(emote.clone(), Vec::new()));
        } else if is_link(token) {
            flush(&mut buffer, out);
            out.push(Node::Link(token.to_string()));
        } else if is_mention(token) {
            flush(&mut buffer, out);
            out.push(Node::Mention(token.to_string()));
        } else {
            buffer.push_str(token);
        }
    }
    flush(&mut buffer, out);
}

fn flush(buffer: &mut String, out: &mut Vec<Node>) {
    if !buffer.is_empty() {
        out.push(Node::Text(std::mem::take(buffer)));
    }
}

/// Fold zero-width emotes onto the emote that precedes them.
fn fold_overlays(nodes: Vec<Node>) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::with_capacity(nodes.len());

    for node in nodes {
        let is_overlay = matches!(&node, Node::Emote(e, _) if e.zero_width);
        if is_overlay {
            // Walk back over whitespace-only text to find a base emote.
            let mut index = out.len();
            while index > 0 {
                match &out[index - 1] {
                    Node::Text(t) if t.trim().is_empty() => index -= 1,
                    Node::Emote(_, _) => break,
                    _ => {
                        index = 0;
                        break;
                    }
                }
            }
            if index > 0 {
                if let Node::Emote(emote, _) = &node {
                    let overlay = Overlay {
                        id: emote.id.clone(),
                        name: emote.name.clone(),
                        url: emote.url.clone(),
                        provider: emote.provider.to_string(),
                    };
                    if let Node::Emote(_, overlays) = &mut out[index - 1] {
                        overlays.push(overlay);
                        out.truncate(index); // drop the whitespace between them
                        continue;
                    }
                }
            }
            // No base emote to sit on -- fall through and render it inline.
        }
        out.push(node);
    }

    out
}

fn to_segments(nodes: Vec<Node>) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Node::Text(text) => {
                // Coalesce runs of text that overlay-folding may have split.
                if let Some(Segment::Text { text: previous }) = segments.last_mut() {
                    previous.push_str(&text);
                } else {
                    segments.push(Segment::Text { text });
                }
            }
            Node::Emote(emote, overlays) => segments.push(Segment::Emote {
                id: emote.id,
                name: emote.name,
                url: emote.url,
                url_large: emote.url_large,
                provider: emote.provider.to_string(),
                overlays,
            }),
            Node::Mention(text) => segments.push(Segment::Mention { text }),
            Node::Link(text) => segments.push(Segment::Link { href: text.clone(), text }),
        }
    }
    segments.retain(|s| !matches!(s, Segment::Text { text } if text.is_empty()));
    segments
}

/// Build message body segments from raw text plus the `emotes` tag.
pub fn build_segments(text: &str, emotes_tag: Option<&str>, emotes: &EmoteLookup) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let mut nodes: Vec<Node> = Vec::new();
    let mut cursor = 0usize;

    for (start, end, id) in emotes_tag.map(parse_emote_ranges).unwrap_or_default() {
        // Ignore ranges that overlap what we already consumed or run off the end.
        if start < cursor || end >= chars.len() {
            continue;
        }
        if start > cursor {
            let gap: String = chars[cursor..start].iter().collect();
            tokenize(&gap, emotes, &mut nodes);
        }
        let name: String = chars[start..=end].iter().collect();
        nodes.push(Node::Emote(twitch_emote(&id, &name), Vec::new()));
        cursor = end + 1;
    }

    if cursor < chars.len() {
        let tail: String = chars[cursor..].iter().collect();
        tokenize(&tail, emotes, &mut nodes);
    }

    to_segments(fold_overlays(nodes))
}

/// Resolve the `badges`/`badge-info` tags into images. Shared by PRIVMSG
/// rendering and USERSTATE (which carries the same tags for our own badges).
pub fn build_badges(msg: &IrcMessage, badges: &BadgeLookup) -> Vec<Badge> {
    let Some(tag) = msg.tag("badges") else { return Vec::new() };
    // badge-info carries the true subscriber month count for the tooltip.
    let badge_info: HashMap<&str, &str> = msg
        .tag("badge-info")
        .unwrap_or("")
        .split(',')
        .filter_map(|entry| entry.split_once('/'))
        .collect();

    tag.split(',')
        .filter_map(|entry| entry.split_once('/'))
        .map(|(set_id, version)| {
            let mut badge = badges.get(set_id, version).cloned().unwrap_or(Badge {
                id: format!("{set_id}/{version}"),
                title: set_id.to_string(),
                url: String::new(),
            });
            if let Some(months) = badge_info.get(set_id) {
                if set_id == "subscriber" {
                    badge.title = format!("{} ({} months)", badge.title, months);
                }
            }
            badge
        })
        .collect()
}

fn timestamp(msg: &IrcMessage) -> i64 {
    msg.tag("tmi-sent-ts").and_then(|t| t.parse().ok()).unwrap_or(0)
}

/// Build a chat message from a PRIVMSG.
pub fn build_chat_message(
    msg: &IrcMessage,
    channel: &str,
    emotes: &EmoteLookup,
    badges: &BadgeLookup,
) -> ChatMessage {
    let login = msg.nick().unwrap_or("unknown").to_string();
    let display_name = msg
        .tag("display-name")
        .filter(|n| !n.is_empty())
        .unwrap_or(&login)
        .to_string();
    let (is_action, body) = strip_action(msg.text().unwrap_or(""));

    // Present only on replies (a native Twitch reply, not our own convention):
    // the parent's login/name/body ride along on the child PRIVMSG's tags.
    let reply_to = msg.tag("reply-parent-msg-id").map(|_| ReplyInfo {
        login: msg.tag("reply-parent-user-login").unwrap_or_default().to_string(),
        display_name: msg.tag("reply-parent-display-name").unwrap_or_default().to_string(),
        body: msg.tag("reply-parent-msg-body").unwrap_or_default().to_string(),
    });

    ChatMessage {
        id: msg.tag("id").unwrap_or_default().to_string(),
        channel: channel.to_string(),
        ts: timestamp(msg),
        color: color::resolve(msg.tag("color"), &login),
        login,
        display_name,
        badges: build_badges(msg, badges),
        segments: build_segments(body, msg.tag("emotes"), emotes),
        is_action,
        is_first_message: msg.tag("first-msg") == Some("1"),
        kind: "chat".to_string(),
        historical: msg.tag("historical") == Some("1"),
        system_message: None,
        reply_to,
    }
}

/// Build the highlighted line for a USERNOTICE (sub, resub, raid, gift...).
pub fn build_usernotice(
    msg: &IrcMessage,
    channel: &str,
    emotes: &EmoteLookup,
    badges: &BadgeLookup,
) -> ChatMessage {
    let login = msg.tag("login").or_else(|| msg.nick()).unwrap_or("twitch").to_string();
    let display_name = msg.tag("display-name").unwrap_or(&login).to_string();
    // USERNOTICE has an optional user comment in the trailing param.
    let body = msg.text().unwrap_or("");

    ChatMessage {
        id: msg.tag("id").unwrap_or_default().to_string(),
        channel: channel.to_string(),
        ts: timestamp(msg),
        color: color::resolve(msg.tag("color"), &login),
        login,
        display_name,
        badges: build_badges(msg, badges),
        segments: build_segments(body, msg.tag("emotes"), emotes),
        is_action: false,
        is_first_message: false,
        kind: "system".to_string(),
        historical: msg.tag("historical") == Some("1"),
        system_message: msg.tag("system-msg").map(|s| s.to_string()),
        reply_to: None,
    }
}

/// An incoming whisper.
///
/// It belongs to no channel: EventSub delivers it outside chat entirely, so
/// `channel` is left empty and the frontend files it under whichever channel
/// you're reading. There are no badges and no color -- EventSub sends neither,
/// so the name falls back to the same palette hash an uncolored chatter gets --
/// and no emote ranges either, so only what the text itself resolves to (7TV
/// globals, links, mentions) comes through.
pub fn whisper(
    id: &str,
    login: &str,
    display_name: &str,
    text: &str,
    ts: i64,
    emotes: &EmoteLookup,
) -> ChatMessage {
    ChatMessage {
        id: id.to_string(),
        channel: String::new(),
        ts,
        color: color::resolve(None, login),
        login: login.to_string(),
        display_name: display_name.to_string(),
        badges: Vec::new(),
        segments: build_segments(text, None, emotes),
        is_action: false,
        is_first_message: false,
        kind: "whisper".to_string(),
        historical: false,
        system_message: None,
        reply_to: None,
    }
}

/// A locally generated status line (connecting, joined, errors).
pub fn notice(channel: &str, text: impl Into<String>) -> ChatMessage {
    ChatMessage {
        id: String::new(),
        channel: channel.to_string(),
        ts: 0,
        login: String::new(),
        display_name: String::new(),
        color: "#8b8b93".to_string(),
        badges: Vec::new(),
        segments: Vec::new(),
        is_action: false,
        is_first_message: false,
        kind: "notice".to_string(),
        historical: false,
        system_message: Some(text.into()),
        reply_to: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emote(name: &str, zero_width: bool) -> Emote {
        Emote {
            id: format!("id-{name}"),
            name: name.to_string(),
            url: format!("https://cdn/{name}.webp"),
            url_large: format!("https://cdn/{name}-4x.webp"),
            provider: "7tv",
            zero_width,
            width: 64,
            height: 64,
        }
    }

    fn lookup(map: &HashMap<String, Emote>) -> EmoteLookup<'_> {
        EmoteLookup { channel: None, global: map }
    }

    fn text_of(segment: &Segment) -> &str {
        match segment {
            Segment::Text { text } => text,
            Segment::Mention { text } => text,
            Segment::Link { text, .. } => text,
            Segment::Emote { name, .. } => name,
        }
    }

    #[test]
    fn plain_text_is_one_segment() {
        let map = HashMap::new();
        let segments = build_segments("hello world", None, &lookup(&map));
        assert_eq!(segments.len(), 1);
        assert_eq!(text_of(&segments[0]), "hello world");
    }

    #[test]
    fn twitch_emote_ranges_are_extracted() {
        let map = HashMap::new();
        let segments = build_segments("Kappa hello", Some("25:0-4"), &lookup(&map));
        assert_eq!(segments.len(), 2);
        match &segments[0] {
            Segment::Emote { name, url, provider, .. } => {
                assert_eq!(name, "Kappa");
                assert_eq!(provider, "twitch");
                assert!(url.contains("/25/"), "unexpected url {url}");
            }
            other => panic!("expected emote, got {other:?}"),
        }
        assert_eq!(text_of(&segments[1]), " hello");
    }

    #[test]
    fn emote_ranges_are_indexed_by_codepoint_not_bytes() {
        // The leading emoji is 1 code point but 4 UTF-8 bytes; byte indexing
        // would slice the wrong substring here (or panic).
        let map = HashMap::new();
        let text = "\u{1F600} Kappa";
        let segments = build_segments(text, Some("25:2-6"), &lookup(&map));
        let emote = segments
            .iter()
            .find(|s| matches!(s, Segment::Emote { .. }))
            .expect("emote segment");
        assert_eq!(text_of(emote), "Kappa");
    }

    #[test]
    fn multiple_ranges_for_one_emote_are_handled() {
        let map = HashMap::new();
        let segments = build_segments("Kappa a Kappa", Some("25:0-4,8-12"), &lookup(&map));
        let count = segments.iter().filter(|s| matches!(s, Segment::Emote { .. })).count();
        assert_eq!(count, 2);
    }

    #[test]
    fn out_of_bounds_ranges_are_ignored() {
        let map = HashMap::new();
        let segments = build_segments("hi", Some("25:0-99"), &lookup(&map));
        assert_eq!(text_of(&segments[0]), "hi");
    }

    #[test]
    fn seventv_emotes_match_whole_words_only() {
        let mut map = HashMap::new();
        map.insert("catJAM".to_string(), emote("catJAM", false));
        let segments = build_segments("wow catJAM nice catJAMS", None, &lookup(&map));

        let emotes: Vec<&str> = segments
            .iter()
            .filter(|s| matches!(s, Segment::Emote { .. }))
            .map(text_of)
            .collect();
        assert_eq!(emotes, vec!["catJAM"], "catJAMS must not match");
    }

    #[test]
    fn zero_width_emotes_fold_onto_the_previous_emote() {
        let mut map = HashMap::new();
        map.insert("catJAM".to_string(), emote("catJAM", false));
        map.insert("RainTime".to_string(), emote("RainTime", true));

        let segments = build_segments("catJAM RainTime", None, &lookup(&map));
        assert_eq!(segments.len(), 1, "overlay should not be its own segment");
        match &segments[0] {
            Segment::Emote { name, overlays, .. } => {
                assert_eq!(name, "catJAM");
                assert_eq!(overlays.len(), 1);
                assert_eq!(overlays[0].name, "RainTime");
            }
            other => panic!("expected emote, got {other:?}"),
        }
    }

    #[test]
    fn multiple_overlays_stack_on_one_base() {
        let mut map = HashMap::new();
        map.insert("catJAM".to_string(), emote("catJAM", false));
        map.insert("RainTime".to_string(), emote("RainTime", true));
        map.insert("SnowTime".to_string(), emote("SnowTime", true));

        let segments = build_segments("catJAM RainTime SnowTime", None, &lookup(&map));
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            Segment::Emote { overlays, .. } => assert_eq!(overlays.len(), 2),
            other => panic!("expected emote, got {other:?}"),
        }
    }

    #[test]
    fn overlay_with_no_base_renders_inline() {
        let mut map = HashMap::new();
        map.insert("RainTime".to_string(), emote("RainTime", true));
        let segments = build_segments("RainTime alone", None, &lookup(&map));
        match &segments[0] {
            Segment::Emote { name, overlays, .. } => {
                assert_eq!(name, "RainTime");
                assert!(overlays.is_empty());
            }
            other => panic!("expected inline emote, got {other:?}"),
        }
    }

    #[test]
    fn overlay_does_not_attach_across_plain_words() {
        let mut map = HashMap::new();
        map.insert("catJAM".to_string(), emote("catJAM", false));
        map.insert("RainTime".to_string(), emote("RainTime", true));
        let segments = build_segments("catJAM word RainTime", None, &lookup(&map));
        let emotes = segments.iter().filter(|s| matches!(s, Segment::Emote { .. })).count();
        assert_eq!(emotes, 2, "overlay separated by text stays separate");
    }

    #[test]
    fn overlay_folds_onto_a_native_twitch_emote() {
        let mut map = HashMap::new();
        map.insert("RainTime".to_string(), emote("RainTime", true));
        let segments = build_segments("Kappa RainTime", Some("25:0-4"), &lookup(&map));
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            Segment::Emote { provider, overlays, .. } => {
                assert_eq!(provider, "twitch");
                assert_eq!(overlays.len(), 1);
            }
            other => panic!("expected emote, got {other:?}"),
        }
    }

    #[test]
    fn links_and_mentions_become_their_own_segments() {
        let map = HashMap::new();
        let segments = build_segments("hey @bob see https://x.com/a", None, &lookup(&map));
        assert!(segments.iter().any(|s| matches!(s, Segment::Mention { text } if text == "@bob")));
        assert!(segments
            .iter()
            .any(|s| matches!(s, Segment::Link { href, .. } if href == "https://x.com/a")));
    }

    #[test]
    fn builds_a_full_message_from_a_real_line() {
        let line = "@badge-info=subscriber/14;badges=subscriber/12;color=#1E90FF;display-name=SomeUser;emotes=25:0-4;first-msg=0;id=abc;tmi-sent-ts=1700000000000 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #forsen :Kappa hi";
        let irc = crate::irc::parse::parse(line).unwrap();

        let emote_map = HashMap::new();
        let mut global_badges = BadgeMap::new();
        global_badges.insert(
            ("subscriber".to_string(), "12".to_string()),
            Badge { id: "subscriber/12".into(), title: "Subscriber".into(), url: "u".into() },
        );

        let message = build_chat_message(
            &irc,
            "forsen",
            &lookup(&emote_map),
            &BadgeLookup { channel: None, global: &global_badges },
        );

        assert_eq!(message.display_name, "SomeUser");
        assert_eq!(message.login, "someuser");
        assert_eq!(message.color, "#1E90FF");
        assert_eq!(message.ts, 1700000000000);
        assert_eq!(message.badges.len(), 1);
        assert_eq!(message.badges[0].title, "Subscriber (14 months)");
        assert!(matches!(message.segments[0], Segment::Emote { .. }));
    }

    #[test]
    fn reply_parent_tags_become_reply_to() {
        let line = "@display-name=Replier;id=xyz;reply-parent-display-name=OrigUser;reply-parent-msg-body=original\\stext;reply-parent-msg-id=abc;reply-parent-user-login=origuser :replier!replier@replier.tmi.twitch.tv PRIVMSG #forsen :agreed";
        let irc = crate::irc::parse::parse(line).unwrap();
        let emote_map = HashMap::new();
        let badge_map = BadgeMap::new();

        let message = build_chat_message(
            &irc,
            "forsen",
            &lookup(&emote_map),
            &BadgeLookup { channel: None, global: &badge_map },
        );

        let reply_to = message.reply_to.expect("reply tags should produce reply_to");
        assert_eq!(reply_to.login, "origuser");
        assert_eq!(reply_to.display_name, "OrigUser");
        assert_eq!(reply_to.body, "original text");
    }

    #[test]
    fn ordinary_messages_have_no_reply_to() {
        let line = "@display-name=SomeUser;id=abc :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #forsen :hi";
        let irc = crate::irc::parse::parse(line).unwrap();
        let emote_map = HashMap::new();
        let badge_map = BadgeMap::new();

        let message = build_chat_message(
            &irc,
            "forsen",
            &lookup(&emote_map),
            &BadgeLookup { channel: None, global: &badge_map },
        );

        assert!(message.reply_to.is_none());
    }

    #[test]
    fn action_messages_are_unwrapped_and_flagged() {
        let line = ":u!u@u PRIVMSG #c :\u{1}ACTION waves\u{1}";
        let irc = crate::irc::parse::parse(line).unwrap();
        let map = HashMap::new();
        let badges = BadgeMap::new();
        let message = build_chat_message(
            &irc,
            "c",
            &lookup(&map),
            &BadgeLookup { channel: None, global: &badges },
        );
        assert!(message.is_action);
        assert_eq!(text_of(&message.segments[0]), "waves");
    }

    #[test]
    fn unknown_badges_still_render_as_text_chips() {
        let line = "@badges=mystery/1 :u!u@u PRIVMSG #c :hi";
        let irc = crate::irc::parse::parse(line).unwrap();
        let map = HashMap::new();
        let badges = BadgeMap::new();
        let message = build_chat_message(
            &irc,
            "c",
            &lookup(&map),
            &BadgeLookup { channel: None, global: &badges },
        );
        assert_eq!(message.badges.len(), 1);
        assert_eq!(message.badges[0].title, "mystery");
        assert!(message.badges[0].url.is_empty());
    }

    #[test]
    fn channel_emotes_shadow_global_ones() {
        let mut global = HashMap::new();
        global.insert("Same".to_string(), emote("Same", false));
        let mut channel = HashMap::new();
        let mut override_emote = emote("Same", false);
        override_emote.url = "https://cdn/channel-version.webp".to_string();
        channel.insert("Same".to_string(), override_emote);

        let lookup = EmoteLookup { channel: Some(&channel), global: &global };
        let segments = build_segments("Same", None, &lookup);
        match &segments[0] {
            Segment::Emote { url, .. } => assert_eq!(url, "https://cdn/channel-version.webp"),
            other => panic!("expected emote, got {other:?}"),
        }
    }
}
