//! Incoming whispers, over EventSub.
//!
//! Twitch doesn't deliver whispers over IRC at all -- receiving one means
//! subscribing to `user.whisper.message` on an EventSub WebSocket, so this is a
//! second socket running alongside the chat connection. It carries the sender
//! and the text and nothing else: no emote ranges, no badges, no color. What
//! the text alone resolves to (7TV globals, links, mentions) comes through;
//! the rest was never sent.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::irc::client::MessageSink;
use crate::render::{self, ChatMessage, EmoteLookup};
use crate::state::AppState;

const WS_URL: &str = "wss://eventsub.wss.twitch.tv/ws";
const SUBSCRIPTIONS_URL: &str = "https://api.twitch.tv/helix/eventsub/subscriptions";
const SUBSCRIPTION_TYPE: &str = "user.whisper.message";

/// Either of these lets us subscribe. The account permission group asks for the
/// second, which also covers sending; the first is what a token from an older
/// build might have instead.
const WHISPER_SCOPES: [&str; 2] = ["user:read:whispers", "user:manage:whispers"];

/// What one frame from the socket means to us.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    /// The session is up. Its id is what a subscription attaches to.
    Welcome(String),
    /// Twitch is retiring this socket; connect to the url it handed over.
    Reconnect(String),
    Whisper { id: String, from_id: String, from_login: String, from_name: String, text: String },
    /// Keepalives, revocations, and anything else we don't act on.
    Ignored,
}

/// Read one frame. Anything malformed or unrecognized is ignored rather than
/// treated as an error: the socket is fine, this frame just isn't for us.
pub fn classify(raw: &str) -> Incoming {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Incoming::Ignored;
    };

    match value["metadata"]["message_type"].as_str().unwrap_or_default() {
        "session_welcome" => match value["payload"]["session"]["id"].as_str() {
            Some(id) if !id.is_empty() => Incoming::Welcome(id.to_string()),
            _ => Incoming::Ignored,
        },
        "session_reconnect" => match value["payload"]["session"]["reconnect_url"].as_str() {
            Some(url) if !url.is_empty() => Incoming::Reconnect(url.to_string()),
            _ => Incoming::Ignored,
        },
        "notification" => {
            // One subscription type lives on this socket, but check anyway --
            // a notification we can't read shouldn't render as an empty
            // whisper from nobody.
            if value["payload"]["subscription"]["type"].as_str() != Some(SUBSCRIPTION_TYPE) {
                return Incoming::Ignored;
            }
            let event = &value["payload"]["event"];
            let from_login = event["from_user_login"].as_str().unwrap_or_default();
            if from_login.is_empty() {
                return Incoming::Ignored;
            }
            Incoming::Whisper {
                id: event["whisper_id"].as_str().unwrap_or_default().to_string(),
                // Carried for the same reason a chat message carries one: it's
                // what a 7TV badge is looked up by.
                from_id: event["from_user_id"].as_str().unwrap_or_default().to_string(),
                from_name: match event["from_user_name"].as_str() {
                    Some(name) if !name.is_empty() => name.to_string(),
                    _ => from_login.to_string(),
                },
                from_login: from_login.to_string(),
                text: event["whisper"]["text"].as_str().unwrap_or_default().to_string(),
            }
        }
        _ => Incoming::Ignored,
    }
}

/// Milliseconds since the epoch, for the timestamp EventSub doesn't put on the
/// event itself. A clock before 1970 reads as 0, the same as a chat message
/// that arrived without one.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve a whisper against the global emote set. Whispers belong to no
/// channel, so there's no channel set to shadow it with.
fn build(
    state: &AppState,
    id: &str,
    user_id: &str,
    login: &str,
    name: &str,
    text: &str,
) -> ChatMessage {
    let globals = state.global_emotes.read();
    let emotes = EmoteLookup { channel: None, global: &globals };
    render::whisper(id, user_id, login, name, text, now_ms(), &emotes)
}

async fn subscribe(
    state: &AppState,
    client_id: &str,
    token: &str,
    user_id: &str,
    session: &str,
) -> Result<()> {
    let response = state
        .http
        .post(SUBSCRIPTIONS_URL)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .json(&json!({
            "type": SUBSCRIPTION_TYPE,
            "version": "1",
            "condition": { "user_id": user_id },
            "transport": { "method": "websocket", "session_id": session },
        }))
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Twitch refused the whisper subscription ({status}): {body}"));
    }
    Ok(())
}

/// One connection. `Ok(Some(url))` means Twitch asked us to move to another
/// socket, which resumes this session's subscriptions; `Ok(None)` means it
/// closed and we start over.
async fn connect_once(
    state: &Arc<AppState>,
    sink: &MessageSink,
    url: &str,
    resuming: bool,
    client_id: &str,
    token: &str,
    user_id: &str,
) -> Result<Option<String>> {
    let (stream, _) = connect_async(url).await?;
    let (mut write, mut read) = stream.split();

    loop {
        tokio::select! {
            // The token changed under us. Reconnecting is the whole response:
            // the subscription belongs to the old one.
            _ = state.eventsub_restart.notified() => return Ok(None),
            frame = read.next() => {
                let Some(frame) = frame else { return Ok(None) };
                match frame? {
                    Message::Text(text) => match classify(&text) {
                        Incoming::Welcome(session) => {
                            // A reconnect url brings its own welcome and keeps
                            // the subscriptions, so only a fresh session has
                            // anything to ask for.
                            if !resuming {
                                subscribe(state, client_id, token, user_id, &session).await?;
                            }
                        }
                        Incoming::Reconnect(next) => return Ok(Some(next)),
                        Incoming::Whisper { id, from_id, from_login, from_name, text } => {
                            state.queue_badge_lookup(&from_id);
                            let _ =
                                sink.send(build(state, &id, &from_id, &from_login, &from_name, &text));
                        }
                        Incoming::Ignored => {}
                    },
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Ok(None),
                    _ => {}
                }
            }
        }
    }
}

/// Keep a whisper socket up for as long as there's a token that can carry one.
///
/// Signed out -- or signed in without the whisper scope, which a token issued
/// by an older build won't have -- this idles on the restart signal rather than
/// retrying, since nothing but a sign-in can change the answer.
pub async fn run(state: Arc<AppState>, sink: MessageSink) {
    let mut backoff_secs = 1u64;
    let mut resume: Option<String> = None;

    loop {
        let credentials = {
            let auth = state.auth.read();
            match (auth.credentials(), auth.user_id.clone()) {
                (Some((client_id, token)), Some(user_id))
                    if WHISPER_SCOPES.iter().any(|scope| auth.has_scope(scope)) =>
                {
                    Some((client_id, token, user_id))
                }
                _ => None,
            }
        };

        let Some((client_id, token, user_id)) = credentials else {
            state.eventsub_restart.notified().await;
            resume = None;
            continue;
        };

        let (url, resuming) = match resume.take() {
            Some(url) => (url, true),
            None => (WS_URL.to_string(), false),
        };

        match connect_once(&state, &sink, &url, resuming, &client_id, &token, &user_id).await {
            Ok(Some(next)) => {
                resume = Some(next);
                backoff_secs = 1;
                continue;
            }
            Ok(None) => backoff_secs = 1,
            Err(error) => eprintln!("whisper socket: {error}"),
        }

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_welcome_carries_the_session_to_subscribe_against() {
        let raw = r#"{"metadata":{"message_type":"session_welcome"},
            "payload":{"session":{"id":"abc123","status":"connected"}}}"#;
        assert_eq!(classify(raw), Incoming::Welcome("abc123".to_string()));
    }

    #[test]
    fn a_notification_reads_back_as_the_whisper_it_is() {
        let raw = r#"{"metadata":{"message_type":"notification"},
            "payload":{"subscription":{"type":"user.whisper.message"},
            "event":{"from_user_id":"1","from_user_login":"forsen","from_user_name":"Forsen",
                     "to_user_id":"2","whisper_id":"w-1","whisper":{"text":"hello there"}}}}"#;
        assert_eq!(
            classify(raw),
            Incoming::Whisper {
                id: "w-1".to_string(),
                from_id: "1".to_string(),
                from_login: "forsen".to_string(),
                from_name: "Forsen".to_string(),
                text: "hello there".to_string(),
            }
        );
    }

    #[test]
    fn a_sender_with_no_display_name_falls_back_to_their_login() {
        let raw = r#"{"metadata":{"message_type":"notification"},
            "payload":{"subscription":{"type":"user.whisper.message"},
            "event":{"from_user_login":"nymn","whisper":{"text":"hi"}}}}"#;
        match classify(raw) {
            Incoming::Whisper { from_name, id, .. } => {
                assert_eq!(from_name, "nymn");
                assert!(id.is_empty(), "a missing whisper id isn't fatal");
            }
            other => panic!("expected a whisper, got {other:?}"),
        }
    }

    #[test]
    fn a_notification_of_some_other_type_is_ignored() {
        // Nothing else is subscribed today, but an empty whisper from nobody is
        // a worse answer than none.
        let raw = r#"{"metadata":{"message_type":"notification"},
            "payload":{"subscription":{"type":"channel.follow"},"event":{"user_login":"x"}}}"#;
        assert_eq!(classify(raw), Incoming::Ignored);
    }

    #[test]
    fn a_keepalive_is_ignored() {
        let raw = r#"{"metadata":{"message_type":"session_keepalive"},"payload":{}}"#;
        assert_eq!(classify(raw), Incoming::Ignored);
    }

    #[test]
    fn a_reconnect_carries_the_socket_to_move_to() {
        let raw = r#"{"metadata":{"message_type":"session_reconnect"},
            "payload":{"session":{"id":"abc","reconnect_url":"wss://eventsub.wss.twitch.tv/ws?id=2"}}}"#;
        assert_eq!(
            classify(raw),
            Incoming::Reconnect("wss://eventsub.wss.twitch.tv/ws?id=2".to_string())
        );
    }

    #[test]
    fn a_frame_that_isnt_json_doesnt_take_the_socket_down() {
        assert_eq!(classify("not json at all"), Incoming::Ignored);
        assert_eq!(classify("{}"), Incoming::Ignored);
    }
}
