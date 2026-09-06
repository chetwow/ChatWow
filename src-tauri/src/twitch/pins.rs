//! Viewer-visible pins. Twitch's supported Helix endpoint is moderator-only;
//! this isolated, anonymous web query reads the same public pin as web chat.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::irc::parse::IrcMessage;
use crate::render::{self, BadgeLookup, ChatMessage, EmoteLookup};
use crate::state::AppState;

const ENDPOINT: &str = "https://gql.twitch.tv/gql";
// Public identifier for the anonymous web query, not ChatWow's OAuth client.
// Never attach an account token, browser cookie, or integrity credential here.
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const QUERY: &str = r#"query ChatWowPinnedMessage($channelID: ID!) {
  channel(id: $channelID) {
    id
    pinnedChatMessages(first: 10) { edges { node {
      id type startsAt endsAt
      pinnedBy { displayName }
      pinnedMessage {
        id sentAt
        sender { id login displayName chatColor }
        content { text fragments { text content {
          __typename ... on Emote { emoteID: id }
          ... on CheermoteToken { bitsAmount }
        } } }
      }
    } } }
  }
}"#;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessage {
    /// Pin identity, rather than message identity: re-pinning is a new pin.
    pub id: String,
    pub message: ChatMessage,
    pub pinned_by: String,
    pub expires_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pin {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    starts_at: String,
    ends_at: Option<String>,
    pinned_by: Option<Person>,
    pinned_message: Message,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    #[serde(default)]
    id: String,
    #[serde(default)]
    login: String,
    display_name: String,
    chat_color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    sent_at: String,
    sender: Person,
    content: Content,
}

#[derive(Deserialize)]
struct Content {
    text: String,
    #[serde(default)]
    fragments: Vec<Fragment>,
}

#[derive(Deserialize)]
struct Fragment {
    text: String,
    content: Option<Value>,
}

fn millis(value: &str) -> Result<i64> {
    Ok((OffsetDateTime::parse(value, &Rfc3339)?.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn parse_response(value: Value, room: &str, now: i64) -> Result<Option<Pin>> {
    // An unavailable field/schema is a failure, not proof the pin was removed.
    if value["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(anyhow!("Twitch pinned-message query unavailable"));
    }
    let channel = &value["data"]["channel"];
    if channel["id"].as_str() != Some(room) {
        return Err(anyhow!("Twitch pinned-message channel mismatch"));
    }
    let edges = channel["pinnedChatMessages"]["edges"]
        .as_array()
        .ok_or_else(|| anyhow!("Twitch pinned-message response unavailable"))?;
    for edge in edges {
        // Paid pin variants can have a different/absent message payload.
        // Skip those before decoding the moderator-pin shape.
        if edge["node"]["type"]
            .as_str()
            .is_some_and(|kind| kind != "MOD")
        {
            continue;
        }
        let pin: Pin = serde_json::from_value(edge["node"].clone())
            .map_err(|_| anyhow!("Unexpected Twitch pinned-message shape"))?;
        if pin.kind != "MOD" || pin.id.is_empty() || pin.pinned_message.id.is_empty() {
            continue;
        }
        let starts = millis(&pin.starts_at)?;
        let ends = pin.ends_at.as_deref().map(millis).transpose()?;
        if starts <= now && ends.is_none_or(|ends| ends > now) {
            return Ok(Some(pin));
        }
    }
    Ok(None)
}

async fn fetch(http: &reqwest::Client, room: &str) -> Result<Option<Pin>> {
    if room.is_empty() || !room.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(anyhow!("Invalid Twitch room ID"));
    }
    let mut response = http.post(ENDPOINT)
        .header("Client-ID", WEB_CLIENT_ID)
        .json(&json!({"operationName": "ChatWowPinnedMessage", "query": QUERY, "variables": {"channelID": room}}))
        .timeout(Duration::from_secs(8)).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 256_000 {
            return Err(anyhow!("Twitch pinned-message response too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_response(serde_json::from_slice(&bytes)?, room, render::now_ms())
}

/// Adapt structured fragments into the existing IRC renderer's code-point
/// ranges. No text is reparsed as IRC; links, third-party emotes and overlays
/// keep the exact same resolution rules as ordinary channel messages.
fn irc_message(message: &Message) -> IrcMessage {
    let mut tags = HashMap::from([
        ("id".into(), message.id.clone()),
        ("user-id".into(), message.sender.id.clone()),
        ("display-name".into(), message.sender.display_name.clone()),
        (
            "color".into(),
            message.sender.chat_color.clone().unwrap_or_default(),
        ),
        (
            "tmi-sent-ts".into(),
            millis(&message.sent_at).unwrap_or_default().to_string(),
        ),
    ]);
    let fragments = &message.content.fragments;
    if fragments
        .iter()
        .map(|fragment| fragment.text.as_str())
        .collect::<String>()
        == message.content.text
    {
        let mut ranges = Vec::new();
        let mut offset = 0;
        let mut bits = 0u64;
        for fragment in fragments {
            let length = fragment.text.chars().count();
            if let Some(content) = &fragment.content {
                if let Some(id) = content["emoteID"].as_str().filter(|id| {
                    !id.is_empty()
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                }) {
                    if length > 0 {
                        ranges.push(format!("{id}:{offset}-{}", offset + length - 1));
                    }
                }
                bits = bits.saturating_add(content["bitsAmount"].as_u64().unwrap_or_default());
            }
            offset += length;
        }
        tags.insert("emotes".into(), ranges.join("/"));
        tags.insert("bits".into(), bits.to_string());
    }
    IrcMessage {
        tags,
        prefix: Some(message.sender.login.clone()),
        command: "PRIVMSG".into(),
        params: vec![String::new(), message.content.text.clone()],
    }
}

fn resolve(state: &AppState, channel: &str, pin: Pin) -> PinnedMessage {
    let data = state.data.read();
    let room = data.get(channel);
    let globals = state.global_emotes.read();
    let badges = state.global_badges.read();
    let message = render::build_chat_message(
        &irc_message(&pin.pinned_message),
        channel,
        &EmoteLookup {
            channel: room.map(|room| &room.emotes),
            global: &globals,
        },
        &BadgeLookup {
            channel: room.map(|room| &room.badges),
            global: &badges,
        },
        room.and_then(|room| room.cheermotes.as_ref()),
    );
    PinnedMessage {
        id: pin.id,
        message,
        pinned_by: pin
            .pinned_by
            .map(|person| person.display_name)
            .unwrap_or_default(),
        expires_at: pin.ends_at.as_deref().and_then(|ends| millis(ends).ok()),
    }
}

pub fn snapshot(state: &AppState) -> HashMap<String, PinnedMessage> {
    let now = render::now_ms();
    state
        .data
        .read()
        .iter()
        .filter_map(|(channel, room)| {
            let pin = room.pinned_message.as_ref()?;
            pin.expires_at
                .is_none_or(|ends| ends > now)
                .then(|| (channel.clone(), pin.clone()))
        })
        .collect()
}

pub async fn run(app: AppHandle, state: Arc<AppState>) {
    let mut checked: HashMap<String, i64> = HashMap::new();
    let mut successful: HashMap<String, i64> = HashMap::new();
    let mut published = Value::Null;
    loop {
        let now = render::now_ms();
        let rooms: HashMap<String, String> = state
            .data
            .read()
            .iter()
            .filter_map(|(channel, room)| Some((channel.clone(), room.room_id.clone()?)))
            .collect();
        checked.retain(|channel, _| rooms.contains_key(channel));
        successful.retain(|channel, _| rooms.contains_key(channel));
        let due: Vec<_> = rooms
            .iter()
            .filter(|(channel, _)| {
                checked
                    .get(*channel)
                    .is_none_or(|checked| now < *checked || now - checked >= 15_000)
            })
            .map(|(channel, room)| (channel.clone(), room.clone()))
            .collect();
        let mut requests = stream::iter(due.into_iter().map(|(channel, room)| {
            let http = &state.http;
            async move {
                let result = fetch(http, &room).await;
                (channel, room, result)
            }
        }))
        .buffer_unordered(4);
        while let Some((channel, room_id, result)) = requests.next().await {
            let now = render::now_ms();
            checked.insert(channel.clone(), now);
            let value = match result {
                Ok(pin) => {
                    successful.insert(channel.clone(), now);
                    Some(pin.map(|pin| resolve(&state, &channel, pin)))
                }
                Err(_) => {
                    log::debug!("pinned-message lookup unavailable for room {room_id}");
                    successful
                        .get(&channel)
                        .is_none_or(|checked| now - checked > 60_000)
                        .then_some(None)
                }
            };
            if let Some(value) = value {
                if let Some(room) = state
                    .data
                    .write()
                    .get_mut(&channel)
                    .filter(|room| room.room_id.as_deref() == Some(&room_id))
                {
                    room.pinned_message = value;
                }
            }
        }
        let pins = snapshot(&state);
        if let Ok(value) = serde_json::to_value(&pins) {
            if value != published {
                let _ = app.emit("chat://pins", &pins);
                published = value;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::Segment;
    use crate::state::ChannelData;

    fn node() -> Value {
        json!({
            "id": "pin-1", "type": "MOD", "startsAt": "2026-09-06T12:00:00Z",
            "endsAt": "2026-09-06T13:00:00Z", "pinnedBy": { "displayName": "Moderator" },
            "pinnedMessage": {
                "id": "message-1", "sentAt": "2026-09-06T11:59:59.123Z",
                "sender": { "id": "2", "login": "alice", "displayName": "Alice", "chatColor": null },
                "content": { "text": "😀 Kappa https://example.com", "fragments": [
                    { "text": "😀 ", "content": null },
                    { "text": "Kappa", "content": { "__typename": "Emote", "emoteID": "25" } },
                    { "text": " https://example.com", "content": null }
                ] }
            }
        })
    }

    fn response(nodes: Vec<Value>) -> Value {
        json!({"data": {"channel": {"id": "123", "pinnedChatMessages": {
            "edges": nodes.into_iter().map(|node| json!({"node": node})).collect::<Vec<_>>()
        }}}})
    }

    fn now() -> i64 {
        millis("2026-09-06T12:30:00Z").unwrap()
    }

    #[test]
    fn empty_is_unpinned_but_missing_or_failed_data_is_not() {
        assert!(parse_response(response(vec![]), "123", now())
            .unwrap()
            .is_none());
        for value in [
            json!({}),
            json!({"data": {"channel": null}}),
            json!({"errors": [{"message": "unavailable"}]}),
            response(vec![json!({"id": "incomplete"})]),
        ] {
            assert!(parse_response(value, "123", now()).is_err());
        }
        assert!(parse_response(response(vec![node()]), "456", now()).is_err());
    }

    #[test]
    fn only_current_moderator_pins_are_shown() {
        let mut expired = node();
        expired["endsAt"] = json!("2026-09-06T12:30:00Z");
        let mut future = node();
        future["startsAt"] = json!("2026-09-06T12:31:00Z");
        let paid = json!({"type": "CHEER", "pinnedMessage": null});
        assert!(
            parse_response(response(vec![expired, future, paid]), "123", now())
                .unwrap()
                .is_none()
        );
        let mut until_stream_ends = node();
        until_stream_ends["endsAt"] = Value::Null;
        let pin = parse_response(response(vec![until_stream_ends]), "123", now())
            .unwrap()
            .unwrap();
        assert_eq!(pin.id, "pin-1");
        assert!(pin.ends_at.is_none());
    }

    #[test]
    fn fragments_use_codepoints_and_the_normal_message_renderer() {
        let pin = parse_response(response(vec![node()]), "123", now())
            .unwrap()
            .unwrap();
        let irc = irc_message(&pin.pinned_message);
        assert_eq!(irc.tags["emotes"], "25:2-6");
        let pin = resolve(&AppState::new(), "room", pin);
        assert_eq!(pin.pinned_by, "Moderator");
        assert_eq!(pin.message.login, "alice");
        assert_eq!(pin.message.ts, millis("2026-09-06T11:59:59.123Z").unwrap());
        assert!(matches!(&pin.message.segments[0], Segment::Text { text } if text == "😀 "));
        assert!(
            matches!(&pin.message.segments[1], Segment::Emote { id, name, .. } if id == "25" && name == "Kappa")
        );
        assert!(pin.message.segments.iter().any(
            |segment| matches!(segment, Segment::Link { href, .. } if href == "https://example.com")
        ));
    }

    #[test]
    fn mismatched_fragments_preserve_text_instead_of_corrupting_emote_ranges() {
        let mut node = node();
        node["pinnedMessage"]["content"]["text"] = json!("Different text");
        let pin = parse_response(response(vec![node]), "123", now())
            .unwrap()
            .unwrap();
        let irc = irc_message(&pin.pinned_message);
        assert!(!irc.tags.contains_key("emotes"));
        assert_eq!(irc.params[1], "Different text");
    }

    #[test]
    fn bits_and_repeated_twitch_emotes_keep_their_occurrence_ranges() {
        let mut node = node();
        node["pinnedMessage"]["content"] = json!({
            "text": "Kappa Kappa Cheer100", "fragments": [
                {"text": "Kappa", "content": {"emoteID": "25"}},
                {"text": " ", "content": null},
                {"text": "Kappa", "content": {"emoteID": "25"}},
                {"text": " ", "content": null},
                {"text": "Cheer100", "content": {"bitsAmount": 100}}
            ]
        });
        let pin = parse_response(response(vec![node]), "123", now())
            .unwrap()
            .unwrap();
        let irc = irc_message(&pin.pinned_message);
        assert_eq!(irc.tags["emotes"], "25:0-4/25:6-10");
        assert_eq!(irc.tags["bits"], "100");
        let pin = resolve(&AppState::new(), "room", pin);
        assert_eq!(
            pin.message
                .segments
                .iter()
                .filter(|s| matches!(s, Segment::Emote { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn snapshots_remove_expired_and_closed_rooms() {
        let state = AppState::new();
        let pin = parse_response(response(vec![node()]), "123", now())
            .unwrap()
            .unwrap();
        let mut pin = resolve(&state, "room", pin);
        pin.expires_at = None;
        state.data.write().insert(
            "room".into(),
            ChannelData {
                pinned_message: Some(pin),
                ..Default::default()
            },
        );
        assert!(snapshot(&state).contains_key("room"));
        state
            .data
            .write()
            .get_mut("room")
            .unwrap()
            .pinned_message
            .as_mut()
            .unwrap()
            .expires_at = Some(0);
        assert!(snapshot(&state).is_empty());
        state.data.write().clear();
        assert!(snapshot(&state).is_empty());
    }

    #[tokio::test]
    #[ignore = "live Twitch anonymous web API"]
    async fn public_query_works_without_account_credentials() {
        let state = AppState::new();
        fetch(&state.http, "106750859").await.unwrap();
    }
}
