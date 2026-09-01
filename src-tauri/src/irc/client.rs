//! The Twitch IRC-over-WebSocket connection.
//!
//! One socket carries every joined channel. The task owns the command receiver
//! across reconnects, so a dropped connection transparently rejoins everything.

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::emotes::{cache, seventv};
use crate::irc::parse::{self, IrcMessage};
use crate::render::{self, BadgeLookup, ChatMessage, EmoteLookup};
use crate::state::{AppState, IrcCommand, MAX_PENDING};
use crate::twitch::{badges, emotes as twitch_emotes};

const GATEWAY: &str = "wss://irc-ws.chat.twitch.tv:443";
/// How long the UI-bound batcher waits before flushing.
const FLUSH_INTERVAL: Duration = Duration::from_millis(80);
const FLUSH_MAX_BATCH: usize = 200;
const ASSET_TIMEOUT: Duration = Duration::from_secs(8);

pub type MessageSink = mpsc::UnboundedSender<ChatMessage>;

fn emit_status(app: &AppHandle, channel: Option<&str>, state: &str, detail: Option<String>) {
    let _ = app.emit(
        "chat://status",
        json!({ "channel": channel, "state": state, "detail": detail }),
    );
}

/// Coalesces messages into batches so a busy channel doesn't flood the IPC bridge.
pub fn spawn_emitter(app: AppHandle) -> MessageSink {
    let (tx, mut rx) = mpsc::unbounded_channel::<ChatMessage>();

    tauri::async_runtime::spawn(async move {
        let mut batch: Vec<ChatMessage> = Vec::with_capacity(FLUSH_MAX_BATCH);
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                received = rx.recv() => {
                    match received {
                        Some(message) => {
                            batch.push(message);
                            if batch.len() >= FLUSH_MAX_BATCH {
                                let _ = app.emit("chat://messages", &batch);
                                batch.clear();
                            }
                        }
                        None => break,
                    }
                }
                _ = ticker.tick() => {
                    if !batch.is_empty() {
                        let _ = app.emit("chat://messages", &batch);
                        batch.clear();
                    }
                }
            }
        }
    });

    tx
}

/// Render one IRC message with the current caches and queue it for the UI.
fn render_and_queue(state: &AppState, sink: &MessageSink, channel: &str, msg: &IrcMessage) {
    let message = {
        let data = state.data.read();
        let channel_data = data.get(channel);
        let global_emotes = state.global_emotes.read();
        let global_badges = state.global_badges.read();

        let emotes = EmoteLookup {
            channel: channel_data.map(|c| &c.emotes),
            global: &global_emotes,
        };
        let badge_lookup = BadgeLookup {
            channel: channel_data.map(|c| &c.badges),
            global: &global_badges,
        };

        match msg.command.as_str() {
            "USERNOTICE" => render::build_usernotice(msg, channel, &emotes, &badge_lookup),
            _ => render::build_chat_message(msg, channel, &emotes, &badge_lookup),
        }
    };

    let _ = sink.send(message);
}

/// Fetch the global 7TV set and global Twitch badges. Safe to call again after login.
pub async fn load_global_assets(app: AppHandle, state: Arc<AppState>) {
    if let Ok(Ok(emotes)) = timeout(ASSET_TIMEOUT, seventv::fetch_global(&state.http)).await {
        *state.global_emotes.write() = emotes;
    }

    let credentials = { state.auth.read().credentials() };
    if let Some((client_id, token)) = credentials {
        let fetch = badges::fetch_global(&state.http, &client_id, &token);
        if let Ok(Ok(map)) = timeout(ASSET_TIMEOUT, fetch).await {
            *state.global_badges.write() = map;
        }

        // Autocomplete only -- Twitch emotes in incoming messages are resolved
        // from each message's own `emotes` tag, not from this list.
        let fetch = twitch_emotes::fetch_global(&state.http, &client_id, &token);
        if let Ok(Ok(names)) = timeout(ASSET_TIMEOUT, fetch).await {
            *state.twitch_global_emotes.write() = names;
        }
    }

    let _ = app.emit(
        "chat://assets",
        json!({
            "globalEmotes": state.global_emotes.read().len(),
            "globalBadges": state.global_badges.read().len(),
        }),
    );

    purge_image_cache(&app, &state);
}

/// Drop cached images for emotes no joined channel can reach any more -- a set
/// the streamer edited, or a channel we've parted. Runs off the hot path: it
/// scans a directory, and nothing is waiting on the result.
///
/// Only once every joined channel's emotes have landed, and the global set with
/// them: half-loaded, "unreachable" would include every emote belonging to a
/// channel still fetching, and we'd evict images we're seconds from needing.
fn purge_image_cache(app: &AppHandle, state: &Arc<AppState>) {
    if !state.emote_sets_are_loaded() {
        return;
    }

    let app = app.clone();
    let active = state.active_cache_keys();
    tauri::async_runtime::spawn_blocking(move || cache::purge(&app, &active));
}

/// Fetch a channel's 7TV set and badges, then flush any messages that arrived first.
async fn load_channel_assets(
    app: AppHandle,
    state: Arc<AppState>,
    sink: MessageSink,
    channel: String,
    room_id: String,
) {
    let emotes = timeout(ASSET_TIMEOUT, seventv::fetch_channel(&state.http, &room_id))
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or_default();

    let credentials = { state.auth.read().credentials() };
    let (badge_map, twitch_emote_names) = match credentials {
        Some((client_id, token)) => {
            let fetch = badges::fetch_channel(&state.http, &client_id, &token, &room_id);
            let badge_map = timeout(ASSET_TIMEOUT, fetch)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default();

            let fetch = twitch_emotes::fetch_channel(&state.http, &client_id, &token, &room_id);
            let names = timeout(ASSET_TIMEOUT, fetch)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default();

            (badge_map, names)
        }
        None => Default::default(),
    };

    let emote_count = emotes.len();
    let pending = {
        let mut data = state.data.write();
        let entry = data.entry(channel.clone()).or_default();
        entry.emotes = emotes;
        entry.twitch_emotes = twitch_emote_names;
        entry.badges = badge_map;
        entry.ready = true;
        std::mem::take(&mut entry.pending)
    };

    for message in &pending {
        render_and_queue(&state, &sink, &channel, message);
    }

    let _ = app.emit(
        "chat://channel-ready",
        json!({ "channel": channel, "emoteCount": emote_count }),
    );

    purge_image_cache(&app, &state);
}

fn handle_line(
    app: &AppHandle,
    state: &Arc<AppState>,
    sink: &MessageSink,
    line: &str,
) -> Option<String> {
    let msg = parse::parse(line)?;

    match msg.command.as_str() {
        "PING" => {
            let token = msg.params.first().cloned().unwrap_or_default();
            return Some(format!("PONG :{token}"));
        }
        "RECONNECT" => {
            // Signalled by the caller via a dedicated marker line.
            emit_status(app, None, "reconnecting", Some("Twitch asked us to reconnect".into()));
        }
        "PRIVMSG" | "USERNOTICE" => {
            let Some(channel) = msg.channel() else { return None };

            let ready = state.data.read().get(&channel).map(|c| c.ready).unwrap_or(false);
            if ready {
                render_and_queue(state, sink, &channel, &msg);
            } else {
                // Hold the message until emotes land so it renders correctly.
                let mut data = state.data.write();
                let entry = data.entry(channel).or_default();
                if entry.pending.len() < MAX_PENDING {
                    entry.pending.push(msg);
                }
            }
        }
        "ROOMSTATE" => {
            let Some(channel) = msg.channel() else { return None };
            // ROOMSTATE carries room-id, which is the broadcaster's Twitch user id.
            // That's exactly what 7TV and the Helix badge endpoint need, and it
            // saves us an authenticated user lookup.
            let Some(room_id) = msg.tag("room-id").map(str::to_string) else { return None };

            let needs_fetch = {
                let mut data = state.data.write();
                let entry = data.entry(channel.clone()).or_default();
                let already = entry.ready && entry.room_id.as_deref() == Some(room_id.as_str());
                entry.room_id = Some(room_id.clone());
                !already
            };

            let _ = app.emit(
                "chat://roomstate",
                json!({ "channel": channel, "roomId": room_id }),
            );

            if needs_fetch {
                tauri::async_runtime::spawn(load_channel_assets(
                    app.clone(),
                    Arc::clone(state),
                    sink.clone(),
                    channel,
                    room_id,
                ));
            }
        }
        "CLEARCHAT" => {
            let Some(channel) = msg.channel() else { return None };
            let _ = app.emit(
                "chat://clear",
                json!({
                    "channel": channel,
                    "login": msg.text(),
                    "duration": msg.tag("ban-duration").and_then(|d| d.parse::<u64>().ok()),
                }),
            );
        }
        "CLEARMSG" => {
            let Some(channel) = msg.channel() else { return None };
            let _ = app.emit(
                "chat://clear",
                json!({ "channel": channel, "messageId": msg.tag("target-msg-id") }),
            );
        }
        "NOTICE" => {
            let channel = msg.channel().unwrap_or_default();
            if let Some(text) = msg.text() {
                let _ = sink.send(render::notice(&channel, text));
            }
        }
        "001" => emit_status(app, None, "connected", None),
        _ => {}
    }

    None
}

/// One connection attempt. Returns Ok(()) when the socket closed cleanly or
/// Twitch asked us to reconnect; the caller loops either way.
async fn connect_once(
    app: &AppHandle,
    state: &Arc<AppState>,
    sink: &MessageSink,
    rx: &mut mpsc::UnboundedReceiver<IrcCommand>,
) -> anyhow::Result<()> {
    emit_status(app, None, "connecting", None);

    let (stream, _) = connect_async(GATEWAY).await?;
    let (mut write, mut read) = stream.split();

    // Anonymous read-only login unless we have a user token.
    let (nick, pass) = {
        let auth = state.auth.read();
        match (&auth.access_token, &auth.login) {
            (Some(token), Some(login)) => (login.clone(), format!("oauth:{token}")),
            _ => {
                let suffix: u32 = rand::thread_rng().gen_range(10_000..99_999);
                (format!("justinfan{suffix}"), "SCHMOOPIIE".to_string())
            }
        }
    };

    // Skip twitch.tv/membership: it floods JOIN/PART on large channels and we
    // don't render a user list.
    write
        .send(Message::Text("CAP REQ :twitch.tv/tags twitch.tv/commands".into()))
        .await?;
    write.send(Message::Text(format!("PASS {pass}").into())).await?;
    write.send(Message::Text(format!("NICK {nick}").into())).await?;

    // Clone first: the guard must not be held across an await.
    let joined: Vec<String> = state.channels.read().clone();
    for channel in joined {
        write.send(Message::Text(format!("JOIN #{channel}").into())).await?;
    }

    loop {
        tokio::select! {
            command = rx.recv() => {
                match command {
                    Some(IrcCommand::Join(channel)) => {
                        write.send(Message::Text(format!("JOIN #{channel}").into())).await?;
                    }
                    Some(IrcCommand::Part(channel)) => {
                        write.send(Message::Text(format!("PART #{channel}").into())).await?;
                    }
                    Some(IrcCommand::Reconnect) => return Ok(()),
                    None => return Ok(()),
                }
            }
            incoming = read.next() => {
                let Some(frame) = incoming else { return Ok(()) };
                match frame? {
                    Message::Text(text) => {
                        // Twitch packs multiple IRC lines into one frame.
                        for line in text.split("\r\n").filter(|l| !l.is_empty()) {
                            if line.starts_with(':') && line.contains(" RECONNECT") {
                                return Ok(());
                            }
                            if let Some(reply) = handle_line(app, state, sink, line) {
                                write.send(Message::Text(reply.into())).await?;
                            }
                        }
                    }
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

/// Supervises the connection, reconnecting with backoff and jitter.
pub async fn run(
    app: AppHandle,
    state: Arc<AppState>,
    sink: MessageSink,
    mut rx: mpsc::UnboundedReceiver<IrcCommand>,
) {
    let mut backoff_secs = 1u64;

    loop {
        let result = connect_once(&app, &state, &sink, &mut rx).await;

        match result {
            Ok(()) => backoff_secs = 1,
            Err(error) => {
                emit_status(&app, None, "disconnected", Some(error.to_string()));
            }
        }

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}
