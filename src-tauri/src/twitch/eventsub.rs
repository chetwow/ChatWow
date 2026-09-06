//! One EventSub socket per signed-in account with open channel tabs. Whispers
//! and channel events share it; subscriptions are reconciled without restarting
//! the socket when tabs or roles change. IRC remains the ordinary chat source.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

use super::chat_events::{self, Subscription};
use crate::irc::client::MessageSink;
use crate::render::{self, now_ms, ChatMessage, EmoteLookup};
use crate::state::AppState;

const WS_URL: &str = "wss://eventsub.wss.twitch.tv/ws";
const SUBSCRIPTIONS_URL: &str = "https://api.twitch.tv/helix/eventsub/subscriptions";
const SUBSCRIPTION_TYPE: &str = "user.whisper.message";

/// What one frame from the socket means to us.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    /// The session is up. Its id is what a subscription attaches to.
    Welcome(String),
    /// Twitch is retiring this socket; connect to the url it handed over.
    Reconnect(String),
    Whisper {
        id: String,
        from_id: String,
        from_login: String,
        from_name: String,
        text: String,
    },
    Channel {
        id: String,
        kind: String,
        event: Value,
    },
    Revoked(String),
    /// Keepalives and anything else we don't act on.
    Ignored,
}

/// Read one frame. Anything malformed or unrecognized is ignored rather than
/// treated as an error: the socket is fine, this frame just isn't for us.
pub fn classify(raw: &str) -> Incoming {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Incoming::Ignored;
    };

    match value["metadata"]["message_type"]
        .as_str()
        .unwrap_or_default()
    {
        "session_welcome" => match value["payload"]["session"]["id"].as_str() {
            Some(id) if !id.is_empty() => Incoming::Welcome(id.to_string()),
            _ => Incoming::Ignored,
        },
        "session_reconnect" => match value["payload"]["session"]["reconnect_url"].as_str() {
            Some(url) if !url.is_empty() => Incoming::Reconnect(url.to_string()),
            _ => Incoming::Ignored,
        },
        "notification" => {
            let kind = value["payload"]["subscription"]["type"]
                .as_str()
                .unwrap_or_default();
            if kind != SUBSCRIPTION_TYPE {
                let id = value["metadata"]["message_id"].as_str().unwrap_or_default();
                if id.is_empty() || !value["payload"]["event"].is_object() {
                    return Incoming::Ignored;
                }
                return Incoming::Channel {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    event: value["payload"]["event"].clone(),
                };
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
                from_id: event["from_user_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                from_name: match event["from_user_name"].as_str() {
                    Some(name) if !name.is_empty() => name.to_string(),
                    _ => from_login.to_string(),
                },
                from_login: from_login.to_string(),
                text: event["whisper"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            }
        }
        "revocation" => value["payload"]["subscription"]["id"]
            .as_str()
            .map(|id| Incoming::Revoked(id.to_string()))
            .unwrap_or(Incoming::Ignored),
        _ => Incoming::Ignored,
    }
}

/// Resolve a whisper against the global emote set. Whispers belong to no
/// channel, so there's no channel set to shadow it with.
fn build(
    state: &AppState,
    account: &str,
    id: &str,
    user_id: &str,
    login: &str,
    name: &str,
    text: &str,
) -> ChatMessage {
    let globals = state.global_emotes.read();
    let emotes = EmoteLookup {
        channel: None,
        global: &globals,
    };
    let mut message = render::whisper(id, user_id, login, name, text, now_ms(), &emotes);
    message.account = account.to_string();
    message
}

async fn subscribe(
    state: &AppState,
    client_id: &str,
    token: &str,
    subscription: &Subscription,
    session: &str,
) -> Result<String> {
    let response = state
        .http
        .post(SUBSCRIPTIONS_URL)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .json(&json!({
            "type": subscription.kind,
            "version": subscription.version,
            "condition": subscription.condition,
            "transport": { "method": "websocket", "session_id": session },
        }))
        .timeout(Duration::from_secs(8))
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(
            "Twitch refused {} subscription ({status})",
            subscription.kind
        ));
    }
    let body: Value = response.json().await?;
    body["data"][0]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Twitch returned no subscription ID"))
}

#[derive(Default)]
struct Subscriptions {
    active: Vec<(Subscription, String)>,
    failed: Vec<(Subscription, tokio::time::Instant)>,
}

impl Subscriptions {
    async fn sync(
        &mut self,
        state: &AppState,
        account: &str,
        client: &str,
        token: &str,
        session: &str,
    ) -> Result<()> {
        let wanted = chat_events::wanted(state, account);
        self.failed
            .retain(|(spec, retry)| wanted.contains(spec) && *retry > tokio::time::Instant::now());
        // At most one HTTP operation per tick so WebSocket reads aren't starved
        // when many tabs open at once or Twitch is slow to answer.
        let obsolete = self
            .active
            .iter()
            .find(|(spec, _)| !wanted.contains(spec))
            .map(|(_, id)| id.clone());
        if let Some(id) = obsolete {
            let response = state
                .http
                .delete(SUBSCRIPTIONS_URL)
                .header("Client-Id", client)
                .bearer_auth(token)
                .query(&[("id", &id)])
                .timeout(Duration::from_secs(8))
                .send()
                .await?;
            if !response.status().is_success()
                && response.status() != reqwest::StatusCode::NOT_FOUND
            {
                return Err(anyhow!(
                    "Twitch refused subscription removal ({})",
                    response.status()
                ));
            }
            self.active.retain(|(_, current)| current != &id);
            return Ok(());
        }
        for spec in wanted {
            if self.active.iter().any(|(active, _)| active == &spec)
                || self.failed.iter().any(|(failed, _)| failed == &spec)
            {
                continue;
            }
            if self.active.len() >= 300 {
                break;
            }
            match subscribe(state, client, token, &spec, session).await {
                Ok(id) => self.active.push((spec, id)),
                Err(error) => {
                    log::warn!("EventSub ({account}): {error}");
                    self.failed
                        .push((spec, tokio::time::Instant::now() + Duration::from_secs(300)));
                }
            }
            return Ok(());
        }
        Ok(())
    }

    fn revoke(&mut self, id: &str) {
        if let Some(index) = self.active.iter().position(|(_, current)| current == id) {
            let (spec, _) = self.active.remove(index);
            log::warn!("EventSub subscription revoked: {}", spec.kind);
            self.failed
                .push((spec, tokio::time::Instant::now() + Duration::from_secs(300)));
        }
    }
}

fn channel_message(
    state: &AppState,
    account: &str,
    id: &str,
    kind: &str,
    event: &Value,
) -> Option<ChatMessage> {
    // Re-check current tabs/scopes at delivery time: a late event from a removed
    // subscription must not reach a newly opened tab or another account.
    let spec = chat_events::wanted(state, account)
        .into_iter()
        .find(|spec| {
            spec.kind == kind
                && spec.condition["broadcaster_user_id"] == event["broadcaster_user_id"]
        })?;
    let text = chat_events::describe(kind, event, account)?;
    let mut message = render::notice(&spec.channel, text);
    message.id = format!("eventsub-{id}");
    message.account = account.to_string();
    message.ts = now_ms();
    message.unbanned_login = chat_events::unbanned_login(kind, event).map(str::to_string);
    Some(message)
}

/// One connection. `Ok(Some(url))` means Twitch asked us to move to another
/// socket, which resumes this session's subscriptions; `Ok(None)` means it
/// closed and we start over.
struct AccountConnection<'a> {
    account: &'a str,
    url: &'a str,
    resuming: bool,
    client_id: &'a str,
    token: &'a str,
}

async fn connect_once(
    state: &Arc<AppState>,
    sink: &MessageSink,
    connection: AccountConnection<'_>,
    subscriptions: &mut Subscriptions,
    seen: &mut VecDeque<String>,
    mut previous: Option<Socket>,
) -> Result<Option<(String, Socket)>> {
    let AccountConnection {
        account,
        url,
        resuming,
        client_id,
        token,
    } = connection;
    let (stream, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(url)).await??;
    let (mut write, mut read) = stream.split();
    let mut session_id = None;
    let mut poll = tokio::time::interval(Duration::from_secs(1));
    let mut keepalive = Duration::from_secs(15);
    let mut deadline = tokio::time::Instant::now() + keepalive;

    // No restart signal to watch here: the supervisor below owns that, and
    // drops this task outright when the accounts change. One shared notify
    // can't wake several sockets anyway.
    loop {
        let (frame, from_previous) = tokio::select! {
            frame = read.next() => (frame, false),
            frame = async { previous.as_mut().unwrap().next().await }, if previous.is_some() => (frame, true),
            _ = tokio::time::sleep_until(deadline) => return Err(anyhow!("EventSub keepalive timed out")),
            _ = poll.tick() => {
                if let Some(session) = session_id.as_deref() {
                    subscriptions.sync(state, account, client_id, token, session).await?;
                }
                continue;
            }
        };
        let Some(frame) = frame else {
            if from_previous {
                previous = None;
                continue;
            }
            return Ok(None);
        };
        if from_previous && frame.is_err() {
            previous = None;
            continue;
        }
        deadline = tokio::time::Instant::now() + keepalive;
        match frame? {
            Message::Text(text) => match classify(&text) {
                Incoming::Welcome(session) => {
                    // Twitch transfers subscriptions only when the replacement
                    // welcomes us. Keep draining the old socket until then.
                    previous = None;
                    // A reconnect url brings its own welcome and keeps the
                    // subscriptions, so only a fresh session has anything to
                    // ask for.
                    if !resuming {
                        *subscriptions = Subscriptions::default();
                    }
                    let value: Value = serde_json::from_str(&text)?;
                    keepalive = Duration::from_secs(
                        value["payload"]["session"]["keepalive_timeout_seconds"]
                            .as_u64()
                            .unwrap_or(60)
                            .clamp(1, 600)
                            + 5,
                    );
                    deadline = tokio::time::Instant::now() + keepalive;
                    subscriptions
                        .sync(state, account, client_id, token, &session)
                        .await?;
                    session_id = Some(session);
                }
                Incoming::Reconnect(next) => {
                    if !from_previous {
                        return Ok(Some((next, write.reunite(read)?)));
                    }
                }
                Incoming::Whisper {
                    id,
                    from_id,
                    from_login,
                    from_name,
                    text,
                } => {
                    if seen.contains(&id) {
                        continue;
                    }
                    remember(seen, &id);
                    state.queue_badge_lookup(&from_id);
                    let _ = sink.send(build(
                        state,
                        account,
                        &id,
                        &from_id,
                        &from_login,
                        &from_name,
                        &text,
                    ));
                }
                Incoming::Channel { id, kind, event } => {
                    if seen.contains(&id) {
                        continue;
                    }
                    remember(seen, &id);
                    if let Some(message) = channel_message(state, account, &id, &kind, &event) {
                        let _ = sink.send(message);
                    }
                }
                Incoming::Revoked(id) => subscriptions.revoke(&id),
                Incoming::Ignored => {}
            },
            Message::Ping(payload) => {
                if from_previous {
                    if let Some(socket) = previous.as_mut() {
                        socket.send(Message::Pong(payload)).await?;
                    }
                } else {
                    write.send(Message::Pong(payload)).await?;
                }
            }
            Message::Close(_) => {
                if from_previous {
                    previous = None;
                } else {
                    return Ok(None);
                }
            }
            _ => {}
        }
    }
}

fn remember(seen: &mut VecDeque<String>, id: &str) {
    if id.is_empty() {
        return;
    }
    if seen.len() == 2048 {
        seen.pop_front();
    }
    seen.push_back(id.to_string());
}

/// Keep one account's EventSub connection up until its supervisor removes it.
async fn run_account(state: Arc<AppState>, sink: MessageSink, account: String) {
    let mut backoff_secs = 1u64;
    let mut resume: Option<(String, Socket)> = None;
    let mut subscriptions = Subscriptions::default();
    let mut seen = VecDeque::new();

    loop {
        // Re-read every time round: a refresh mid-session replaces the token
        // under us, and the next connection should use the new one.
        let Some((client_id, token)) = ({ state.auth.read().credentials(&account) }) else {
            return;
        };

        let (url, previous) = match resume.take() {
            Some((url, socket)) => (url, Some(socket)),
            None => (WS_URL.to_string(), None),
        };

        match connect_once(
            &state,
            &sink,
            AccountConnection {
                account: &account,
                url: &url,
                resuming: previous.is_some(),
                client_id: &client_id,
                token: &token,
            },
            &mut subscriptions,
            &mut seen,
            previous,
        )
        .await
        {
            Ok(Some(next)) => {
                resume = Some(next);
                backoff_secs = 1;
                continue;
            }
            Ok(None) => backoff_secs = 1,
            Err(error) => log::warn!("EventSub socket ({account}): {error}"),
        }

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

/// Reconcile account tasks. Tab/role changes preserve existing connections;
/// credential changes and system wake use the explicit restart signal.
pub async fn run(state: Arc<AppState>, sink: MessageSink) {
    let mut running: HashMap<String, tauri::async_runtime::JoinHandle<()>> = HashMap::new();
    loop {
        let open = state.wanted();
        let wanted: Vec<String> = {
            let auth = state.auth.read();
            auth.accounts
                .iter()
                .filter(|account| open.contains_key(&account.id))
                .map(|account| account.id.clone())
                .collect()
        };
        running.retain(|account, handle| {
            if wanted.contains(account) {
                true
            } else {
                handle.abort();
                false
            }
        });
        for account in wanted {
            running.entry(account.clone()).or_insert_with(|| {
                // Deliberate abortion on sign-out/last-tab close is normal.
                tauri::async_runtime::spawn(run_account(Arc::clone(&state), sink.clone(), account))
            });
        }
        tokio::select! {
            _ = state.eventsub_restart.notified() => {
                for (_, handle) in running.drain() { handle.abort(); }
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_events_are_routed_by_room_and_account_not_payload_login() {
        let state = chat_events::tests::fixture();
        let event = json!({"broadcaster_user_id":"2", "broadcaster_user_login":"wrong-room", "user_id":"1", "message":{"text":"banphrase"}});
        let message = channel_message(
            &state,
            "1",
            "event-id",
            "channel.chat.user_message_hold",
            &event,
        )
        .unwrap();
        assert_eq!(message.channel, "room");
        assert_eq!(message.account, "1");
        assert_eq!(message.kind, "notice");
        assert_eq!(message.id, "eventsub-event-id");
        assert!(channel_message(
            &state,
            "2",
            "event-id",
            "channel.chat.user_message_hold",
            &event
        )
        .is_none());
        state.tabs.write().clear();
        assert!(channel_message(
            &state,
            "1",
            "event-id",
            "channel.chat.user_message_hold",
            &event
        )
        .is_none());
    }

    #[test]
    fn a_channel_envelope_keeps_its_deduplication_id_and_revocations_are_handled() {
        let event = json!({"broadcaster_user_id":"2"});
        let raw = json!({"metadata":{"message_type":"notification","message_id":"delivery-1"},
            "payload":{"subscription":{"type":"channel.shared_chat.end"},"event":event}})
        .to_string();
        assert_eq!(
            classify(&raw),
            Incoming::Channel {
                id: "delivery-1".into(),
                kind: "channel.shared_chat.end".into(),
                event
            }
        );
        assert_eq!(
            classify(
                r#"{"metadata":{"message_type":"revocation"},"payload":{"subscription":{"id":"sub-1"}}}"#
            ),
            Incoming::Revoked("sub-1".into())
        );
        let state = chat_events::tests::fixture();
        let spec = chat_events::wanted(&state, "1").remove(0);
        let mut subscriptions = Subscriptions {
            active: vec![(spec.clone(), "sub-1".into())],
            failed: Vec::new(),
        };
        subscriptions.revoke("sub-1");
        assert!(subscriptions.active.is_empty());
        assert_eq!(subscriptions.failed[0].0, spec);
    }

    #[test]
    fn the_duplicate_window_is_bounded_across_reconnects() {
        let mut seen = VecDeque::new();
        for id in 0..2100 {
            remember(&mut seen, &id.to_string());
        }
        assert_eq!(seen.len(), 2048);
        assert!(seen.contains(&"2099".into()));
        assert!(!seen.contains(&"0".into()));
    }

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
        // Missing delivery metadata must not turn an unrelated event into a whisper.
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
