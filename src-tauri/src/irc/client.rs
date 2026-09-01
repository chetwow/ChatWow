//! The Twitch IRC-over-WebSocket connections.
//!
//! One socket per account, carrying every channel that account has a tab on.
//! IRC authenticates per connection -- the login is the connection -- so
//! reading as two accounts at once is two sockets, and there is no way to do it
//! on one. `sync` is what keeps the set of sockets, and what each is joined to,
//! matching the open tabs; each task owns its command receiver across
//! reconnects, so a dropped connection transparently rejoins everything.

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::emotes::{self, bttv, cache, ffz, seventv, Emote, Providers};
use crate::irc::history;
use crate::irc::parse::{self, ChannelRole, IrcMessage};
use crate::render::{self, BadgeLookup, ChatMessage, EmoteLookup};
use crate::state::{AppState, Connection, IrcCommand, MAX_PENDING};
use crate::twitch::{badges, emotes as twitch_emotes};

const GATEWAY: &str = "wss://irc-ws.chat.twitch.tv:443";
/// How long the UI-bound batcher waits before flushing.
const FLUSH_INTERVAL: Duration = Duration::from_millis(80);
const FLUSH_MAX_BATCH: usize = 200;
const ASSET_TIMEOUT: Duration = Duration::from_secs(8);
/// Tighter than the asset timeout: a channel can't render until its backlog
/// has been placed (it belongs above the live messages waiting behind it), so
/// a slow history server would otherwise hold up the whole join.
const HISTORY_TIMEOUT: Duration = Duration::from_secs(4);

pub type MessageSink = mpsc::UnboundedSender<ChatMessage>;

fn emit_status(app: &AppHandle, account: &str, state: &str, detail: Option<String>) {
    let _ = app.emit(
        "chat://status",
        json!({ "account": account, "state": state, "detail": detail }),
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
///
/// Stamped with the account whose socket received it: the renderer resolves
/// emotes and badges, which are the room's, and routing is the connection's
/// business. With the same channel open under two accounts, this stamp is the
/// only thing telling their two copies apart.
fn render_and_queue(
    state: &AppState,
    sink: &MessageSink,
    account: &str,
    channel: &str,
    msg: &IrcMessage,
) {
    let mut message = {
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

    // Every message names its sender; the state remembers who has already been
    // asked about, so this is a set lookup for all but the first.
    state.queue_badge_lookup(msg.tag("user-id").unwrap_or_default());

    message.account = account.to_string();
    let _ = sink.send(message);
}

/// One provider's map, or an empty one -- a provider that's switched off is
/// never asked, and one that's down or slow costs only its own emotes.
async fn or_empty(
    enabled: bool,
    fetch: impl std::future::Future<Output = anyhow::Result<HashMap<String, Emote>>>,
) -> HashMap<String, Emote> {
    if !enabled {
        return HashMap::new();
    }
    timeout(ASSET_TIMEOUT, fetch).await.ok().and_then(|result| result.ok()).unwrap_or_default()
}

/// Every enabled provider's global set, merged. They're fetched together --
/// three sequential round trips would be three chances to hold up a join.
async fn global_emotes(state: &AppState, providers: Providers) -> HashMap<String, Emote> {
    let (ffz_set, bttv_set, seventv_set) = tokio::join!(
        or_empty(providers.ffz, ffz::fetch_global(&state.http)),
        or_empty(providers.bttv, bttv::fetch_global(&state.http)),
        or_empty(providers.seventv, seventv::fetch_global(&state.http)),
    );
    // Lowest priority first: where two providers ship the same name, 7TV's is
    // the one channels actually curate, so it wins.
    emotes::merge(vec![ffz_set, bttv_set, seventv_set])
}

/// The same for one channel's sets, keyed by its Twitch user id.
async fn channel_emotes(
    state: &AppState,
    providers: Providers,
    room_id: &str,
) -> HashMap<String, Emote> {
    let (ffz_set, bttv_set, seventv_set) = tokio::join!(
        or_empty(providers.ffz, ffz::fetch_channel(&state.http, room_id)),
        or_empty(providers.bttv, bttv::fetch_channel(&state.http, room_id)),
        or_empty(providers.seventv, seventv::fetch_channel(&state.http, room_id)),
    );
    emotes::merge(vec![ffz_set, bttv_set, seventv_set])
}

/// Which providers to ask, as of now. Read into an owned value: the guard
/// can't be held across the awaits that follow.
fn providers(state: &AppState) -> Providers {
    Providers::from(&*state.preferences.read())
}

/// Fetch the global emote sets and global Twitch badges. Safe to call again
/// after login, or after the enabled providers change.
pub async fn load_global_assets(app: AppHandle, state: Arc<AppState>) {
    let emotes = global_emotes(&state, providers(&state)).await;
    *state.global_emotes.write() = emotes;

    // Badge *images* are the same whoever asks, so any account's token will
    // do -- which is what keeps them working while the tab you're looking at
    // is anonymous.
    let credentials = { state.auth.read().any_credentials() };
    if let Some((client_id, token)) = credentials {
        let fetch = badges::fetch_global(&state.http, &client_id, &token);
        if let Ok(Ok(map)) = timeout(ASSET_TIMEOUT, fetch).await {
            *state.global_badges.write() = map;
        }
    }

    // Twitch's global emotes include what each account subscribes to, so
    // unlike badges these are asked for once per account. Autocomplete only --
    // Twitch emotes in incoming messages are resolved from each message's own
    // `emotes` tag, not from this list.
    let accounts: Vec<String> =
        { state.auth.read().accounts.iter().map(|account| account.id.clone()).collect() };
    for id in accounts {
        let Some((client_id, token)) = ({ state.auth.read().credentials(&id) }) else { continue };
        let fetch = twitch_emotes::fetch_global(&state.http, &client_id, &token);
        if let Ok(Ok(names)) = timeout(ASSET_TIMEOUT, fetch).await {
            state.twitch_global_emotes.write().insert(id, names);
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

/// Bring one account's join of one channel up to ready: the room's assets if
/// nobody has fetched them yet, then this account's own emotes and backlog,
/// then the messages that arrived while all that was in flight.
///
/// Split that way because the two halves have different owners. The emote and
/// badge sets belong to the room -- the same for every account watching it, so
/// fetched once -- while the backlog, the buffered messages and the Twitch
/// emotes this login owns belong to the session, and a second account joining a
/// channel the first is already in still needs all of them.
async fn load_channel_assets(
    app: AppHandle,
    state: Arc<AppState>,
    sink: MessageSink,
    account: String,
    channel: String,
    room_id: String,
) {
    let needs_assets = !state.data.read().get(&channel).is_some_and(|data| data.assets_ready);
    if needs_assets {
        let emotes = channel_emotes(&state, providers(&state), &room_id).await;

        let credentials = { state.auth.read().any_credentials() };
        let badge_map = match credentials {
            Some((client_id, token)) => {
                let fetch = badges::fetch_channel(&state.http, &client_id, &token, &room_id);
                timeout(ASSET_TIMEOUT, fetch)
                    .await
                    .ok()
                    .and_then(|result| result.ok())
                    .unwrap_or_default()
            }
            None => Default::default(),
        };

        let mut data = state.data.write();
        let entry = data.entry(channel.clone()).or_default();
        entry.emotes = emotes;
        entry.badges = badge_map;
        entry.assets_ready = true;
    }

    // This account's own emotes here -- its sub emotes, which no other
    // account's list can stand in for.
    let credentials = { state.auth.read().credentials(&account) };
    let twitch_emote_names = match credentials {
        Some((client_id, token)) => {
            let fetch = twitch_emotes::fetch_channel(&state.http, &client_id, &token, &room_id);
            timeout(ASSET_TIMEOUT, fetch)
                .await
                .ok()
                .and_then(|result| result.ok())
                .unwrap_or_default()
        }
        None => Vec::new(),
    };

    // Fetched before the session is marked ready, so live messages keep
    // buffering into `pending` meanwhile and the backlog can be queued ahead of
    // them. A failure here is a non-event: no backlog, not a broken join.
    //
    // Read into a bool first -- the guard can't be held across the await.
    let wants_history = state.preferences.read().show_message_history;
    let backlog = match wants_history {
        true => timeout(HISTORY_TIMEOUT, history::fetch(&state.http, &channel))
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or_default(),
        false => Vec::new(),
    };

    let emote_count = state.data.read().get(&channel).map(|data| data.emotes.len()).unwrap_or(0);
    let pending = {
        let mut sessions = state.sessions.write();
        let session = sessions.entry((account.clone(), channel.clone())).or_default();
        session.twitch_emotes = twitch_emote_names;
        session.ready = true;
        std::mem::take(&mut session.pending)
    };

    // The history runs up to now and `pending` starts partway through it, so
    // the two overlap by however long the fetches took. Twitch's message ids
    // settle it exactly.
    let live: HashSet<&str> = pending.iter().filter_map(|message| message.tag("id")).collect();

    for message in &backlog {
        if message.tag("id").is_some_and(|id| live.contains(id)) {
            continue;
        }
        render_and_queue(&state, &sink, &account, &channel, message);
    }

    for message in &pending {
        render_and_queue(&state, &sink, &account, &channel, message);
    }

    let _ = app.emit(
        "chat://channel-ready",
        json!({ "account": account, "channel": channel, "emoteCount": emote_count }),
    );

    purge_image_cache(&app, &state);
}

/// Re-fetch the emote sets after the enabled providers changed. Only the
/// emotes: badges, roles and history are unaffected, and a channel that's
/// already ready stays ready -- nothing here touches `pending`.
///
/// Messages already rendered keep the emotes they were resolved with; the
/// frontend is what stops drawing a switched-off provider's images in the
/// backlog (see `EmoteView`). This is what makes switching one back *on* work.
pub async fn reload_emotes(app: AppHandle, state: Arc<AppState>) {
    let providers = providers(&state);

    let global = global_emotes(&state, providers).await;
    *state.global_emotes.write() = global;

    let rooms: Vec<(String, String)> = state
        .data
        .read()
        .iter()
        .filter_map(|(channel, data)| {
            data.room_id.clone().map(|room_id| (channel.clone(), room_id))
        })
        .collect();

    for (channel, room_id) in rooms {
        let emotes = channel_emotes(&state, providers, &room_id).await;
        if let Some(entry) = state.data.write().get_mut(&channel) {
            entry.emotes = emotes;
        }
    }

    // The frontend rebuilds every channel's completion index off this, which
    // is exactly what a changed provider set needs.
    let _ = app.emit(
        "chat://assets",
        json!({
            "globalEmotes": state.global_emotes.read().len(),
            "globalBadges": state.global_badges.read().len(),
        }),
    );

    purge_image_cache(&app, &state);
}

fn handle_line(
    app: &AppHandle,
    state: &Arc<AppState>,
    sink: &MessageSink,
    account: &str,
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
            emit_status(app, account, "reconnecting", Some("Twitch asked us to reconnect".into()));
        }
        "PRIVMSG" | "USERNOTICE" => {
            let Some(channel) = msg.channel() else { return None };

            let key = (account.to_string(), channel.clone());
            let ready = state.sessions.read().get(&key).map(|s| s.ready).unwrap_or(false);
            if ready {
                render_and_queue(state, sink, account, &channel, &msg);
            } else {
                // Hold the message until emotes land so it renders correctly.
                let mut sessions = state.sessions.write();
                let session = sessions.entry(key).or_default();
                if session.pending.len() < MAX_PENDING {
                    session.pending.push(msg);
                }
            }
        }
        "USERSTATE" => {
            let Some(channel) = msg.channel() else { return None };
            let role = ChannelRole::of(&msg);

            // Twitch repeats USERSTATE after every message we send, so only a
            // real change is worth waking the UI for.
            let changed = {
                let mut sessions = state.sessions.write();
                let session =
                    sessions.entry((account.to_string(), channel.clone())).or_default();
                let changed = session.role != role;
                session.role = role;
                changed
            };
            if changed {
                let _ = app.emit(
                    "chat://role",
                    json!({
                        "account": account,
                        "channel": channel,
                        "moderator": role.moderator,
                        "broadcaster": role.broadcaster,
                    }),
                );
            }
        }
        "ROOMSTATE" => {
            let Some(channel) = msg.channel() else { return None };
            // ROOMSTATE carries room-id, which is the broadcaster's Twitch user id.
            // That's exactly what 7TV and the Helix badge endpoint need, and it
            // saves us an authenticated user lookup.
            let Some(room_id) = msg.tag("room-id").map(str::to_string) else { return None };

            // Per session, not per channel: a second account joining a room
            // the first is already in still needs its own backlog and its own
            // emotes, even though the room's sets are already in hand.
            let needs_fetch = {
                state.data.write().entry(channel.clone()).or_default().room_id =
                    Some(room_id.clone());
                !state
                    .sessions
                    .read()
                    .get(&(account.to_string(), channel.clone()))
                    .is_some_and(|session| session.ready)
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
                    account.to_string(),
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
                    "account": account,
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
                json!({
                    "account": account,
                    "channel": channel,
                    "messageId": msg.tag("target-msg-id"),
                }),
            );
        }
        "NOTICE" => {
            let channel = msg.channel().unwrap_or_default();
            if let Some(text) = msg.text() {
                let mut notice = render::notice(&channel, text);
                notice.account = account.to_string();
                let _ = sink.send(notice);
            }
        }
        "001" => emit_status(app, account, "connected", None),
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
    account: &str,
    rx: &mut mpsc::UnboundedReceiver<IrcCommand>,
) -> anyhow::Result<Outcome> {
    emit_status(app, account, "connecting", None);

    let (stream, _) = connect_async(GATEWAY).await?;
    let (mut write, mut read) = stream.split();

    // Anonymous read-only login unless this connection belongs to an account.
    // An account whose token has gone (signed out from under it) falls back to
    // anonymous rather than failing: the tab keeps reading.
    let (nick, pass) = {
        let auth = state.auth.read();
        match auth.account(account) {
            Some(account) => (account.login.clone(), format!("oauth:{}", account.access_token)),
            None => {
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

    // What this account's tabs ask for, as of now. Clone first: the guard must
    // not be held across an await.
    let joined: Vec<String> = state
        .connections
        .read()
        .get(account)
        .map(|connection| connection.joined.iter().cloned().collect())
        .unwrap_or_default();
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
                    Some(IrcCommand::Reconnect) => return Ok(Outcome::Reconnect),
                    // Nobody left to talk to: the last tab on this account
                    // closed, or the account itself was removed.
                    Some(IrcCommand::Shutdown) | None => return Ok(Outcome::Done),
                }
            }
            incoming = read.next() => {
                let Some(frame) = incoming else { return Ok(Outcome::Reconnect) };
                match frame? {
                    Message::Text(text) => {
                        // Twitch packs multiple IRC lines into one frame.
                        for line in text.split("\r\n").filter(|l| !l.is_empty()) {
                            if line.starts_with(':') && line.contains(" RECONNECT") {
                                return Ok(Outcome::Reconnect);
                            }
                            if let Some(reply) = handle_line(app, state, sink, account, line) {
                                write.send(Message::Text(reply.into())).await?;
                            }
                        }
                    }
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Ok(Outcome::Reconnect),
                    _ => {}
                }
            }
        }
    }
}

/// Why a connection attempt ended: come back, or stay down.
enum Outcome {
    Reconnect,
    Done,
}

/// Supervises one account's connection, reconnecting with backoff and jitter.
pub async fn run(
    app: AppHandle,
    state: Arc<AppState>,
    sink: MessageSink,
    account: String,
    mut rx: mpsc::UnboundedReceiver<IrcCommand>,
) {
    let mut backoff_secs = 1u64;

    loop {
        match connect_once(&app, &state, &sink, &account, &mut rx).await {
            Ok(Outcome::Done) => break,
            Ok(Outcome::Reconnect) => backoff_secs = 1,
            Err(error) => {
                emit_status(&app, &account, "disconnected", Some(error.to_string()));
            }
        }

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }

    // Whatever was buffered for this account is nobody's now.
    state.sessions.write().retain(|(id, _), _| id != &account);
    emit_status(&app, &account, "closed", None);
}

/// Bring the connections in line with the tabs.
///
/// The one place sockets are created or destroyed: every tab change (opened,
/// closed, reassigned to another account, or an account removed under it) ends
/// here, and the diff decides what actually has to happen. Idempotent, so a
/// caller that isn't sure whether anything changed can simply call it.
pub fn sync(app: &AppHandle, state: &Arc<AppState>) {
    let Some(sink) = ({ state.sink.read().clone() }) else { return };
    let wanted = state.wanted();

    let mut connections = state.connections.write();

    // Accounts with nothing open any more. The task tears down its own
    // sessions once it sees this.
    connections.retain(|account, connection| {
        let keep = wanted.contains_key(account);
        if !keep {
            let _ = connection.commands.send(IrcCommand::Shutdown);
        }
        keep
    });

    for (account, channels) in wanted {
        let connection = connections.entry(account.clone()).or_insert_with(|| {
            let (tx, rx) = mpsc::unbounded_channel::<IrcCommand>();
            tauri::async_runtime::spawn(run(
                app.clone(),
                Arc::clone(state),
                sink.clone(),
                account.clone(),
                rx,
            ));
            Connection { commands: tx, joined: HashSet::new() }
        });

        for channel in channels.difference(&connection.joined) {
            let _ = connection.commands.send(IrcCommand::Join(channel.clone()));
        }
        for channel in connection.joined.difference(&channels) {
            let _ = connection.commands.send(IrcCommand::Part(channel.clone()));
            // Its buffered messages and role go with it: coming back is a
            // fresh join, backlog and all.
            state.sessions.write().remove(&(account.clone(), channel.clone()));
        }
        connection.joined = channels;
    }
    drop(connections);

    // A channel no tab is on any more keeps nothing: its emotes and badges are
    // re-fetched on the next join, and holding them would keep their images
    // pinned in the cache.
    let open = state.open_channels();
    state.data.write().retain(|channel, _| open.contains(channel));
}

/// Drop and rebuild every connection -- after a sign-in, a sign-out, or a
/// Client ID change, all of which change who a socket is logged in as.
pub fn reconnect_all(state: &Arc<AppState>) {
    for connection in state.connections.read().values() {
        let _ = connection.commands.send(IrcCommand::Reconnect);
    }
}
