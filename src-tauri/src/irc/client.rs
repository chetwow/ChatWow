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
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::emotes::{bttv, cache, catalog, ffz, seventv, Emote, Providers};
use crate::irc::history;
use crate::irc::parse::{self, ChannelRole, IrcMessage};
use crate::render::{self, BadgeLookup, ChatMessage, EmoteLookup};
use crate::state::{AppState, Connection, IrcCommand, Session, SessionKey, MAX_PENDING};
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

fn connection_is_current(state: &AppState, account: &str, generation: u64) -> bool {
    state
        .connections
        .read()
        .get(account)
        .is_some_and(|connection| connection.generation == generation)
}

fn session_for_generation(
    sessions: &mut HashMap<SessionKey, Session>,
    key: SessionKey,
    generation: u64,
) -> &mut Session {
    let session = sessions.entry(key).or_default();
    if session.connection_generation != generation {
        *session = Session {
            connection_generation: generation,
            ..Default::default()
        };
    }
    session
}

fn begin_load(session: &mut Session, load_generation: u64) -> u64 {
    session.load_generation = load_generation;
    session.loading = true;
    session.load_generation
}

fn load_is_current(session: &Session, connection_generation: u64, load_generation: u64) -> bool {
    session.connection_generation == connection_generation
        && session.load_generation == load_generation
        && session.loading
}

#[derive(Clone)]
struct SessionLoad {
    account: String,
    channel: String,
    connection_generation: u64,
    load_generation: u64,
}

/// Said in every channel an account was reading the moment its socket goes.
/// The connection dot in the title bar says the same thing, but chat is where
/// you're looking, and a channel that has simply stopped moving is otherwise
/// indistinguishable from a quiet one.
const DROPPED: &str = "Disconnected from Twitch -- reconnecting";

/// A notice the app wrote itself, addressed to one account's view of a
/// channel. Stamped like any other message, since that's what routes it to
/// the right tab when a channel is open under two accounts.
fn stamped(account: &str, channel: &str, text: impl Into<String>) -> ChatMessage {
    let mut notice = render::notice(channel, text);
    notice.account = account.to_string();
    notice
}

/// The other half of `DROPPED`, once the gap has been filled in. It names a
/// count because the messages above it are the answer to "what did I miss" --
/// and because nothing recovered is worth saying plainly rather than leaving
/// you to wonder whether the channel was quiet or the fetch failed.
fn resumed(recovered: usize) -> String {
    match recovered {
        0 => "Reconnected".to_string(),
        1 => "Reconnected -- 1 message recovered".to_string(),
        many => format!("Reconnected -- {many} messages recovered"),
    }
}

fn emit_status(app: &AppHandle, account: &str, state: &str, detail: Option<String>) {
    // The same line the UI's connection dot gets, written down: a log read
    // after the fact is mostly the story of which socket was up when.
    match detail.as_deref() {
        Some(detail) => log::info!("irc ({account}): {state} -- {detail}"),
        None => log::info!("irc ({account}): {state}"),
    }
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

/// Backlog first, then the live lines buffered while it loaded.
///
/// The history service can contain the same Twitch message the socket already
/// delivered. Prefer the live copy so it keeps its non-historical behavior.
fn initial_join_messages<'a>(
    backlog: &'a [IrcMessage],
    pending: &'a [IrcMessage],
) -> Vec<&'a IrcMessage> {
    let live: HashSet<&str> = pending
        .iter()
        .filter_map(|message| message.tag("id"))
        .collect();
    backlog
        .iter()
        .filter(|message| !message.tag("id").is_some_and(|id| live.contains(id)))
        .chain(pending)
        .collect()
}

/// One provider's answer, or nothing -- a provider that's switched off is
/// never asked, and one that's down or slow costs only its own emotes.
async fn optional<T>(
    enabled: bool,
    fetch: impl std::future::Future<Output = anyhow::Result<T>>,
) -> Option<T> {
    if !enabled {
        return None;
    }
    timeout(ASSET_TIMEOUT, fetch)
        .await
        .ok()
        .and_then(|result| result.ok())
}

/// Every enabled provider's global set, merged. They're fetched together --
/// three sequential round trips would be three chances to hold up a join.
async fn fetch_global_emotes(state: &AppState, providers: Providers) -> catalog::ProviderSets {
    let (ffz_set, bttv_set, seventv_set) = tokio::join!(
        optional(providers.ffz, ffz::fetch_global(&state.http)),
        optional(providers.bttv, bttv::fetch_global(&state.http)),
        optional(providers.seventv, seventv::fetch_global(&state.http)),
    );
    catalog::ProviderSets {
        ffz: ffz_set,
        bttv: bttv_set,
        seventv: seventv_set.map(|emotes| catalog::SevenTvSet { id: None, emotes }),
    }
}

/// One channel's sets from every enabled provider, as `ChannelData` holds
/// them.
struct ChannelEmotes {
    merged: HashMap<String, Emote>,
    others: HashMap<String, Emote>,
    seventv_set: Option<String>,
}

/// The same for one channel's sets, keyed by its Twitch user id.
async fn fetch_channel_emotes(
    state: &AppState,
    providers: Providers,
    room_id: &str,
) -> catalog::ProviderSets {
    let (ffz_set, bttv_set, seventv) = tokio::join!(
        optional(providers.ffz, ffz::fetch_channel(&state.http, room_id)),
        optional(providers.bttv, bttv::fetch_channel(&state.http, room_id)),
        optional(
            providers.seventv,
            seventv::fetch_channel(&state.http, room_id)
        ),
    );
    catalog::ProviderSets {
        ffz: ffz_set,
        bttv: bttv_set,
        seventv: seventv.map(|set| catalog::SevenTvSet {
            id: set.id,
            emotes: set.emotes,
        }),
    }
}

fn channel_emotes(sets: catalog::ProviderSets, providers: Providers) -> ChannelEmotes {
    // The two lower-priority sets are kept as well as merged: 7TV's emotes can
    // come and go while the channel is open, and a name uncovered by one
    // leaving has to be findable again -- see `ChannelData::other_emotes`.
    let (merged, others, seventv_set) = sets.channel_parts(providers);
    ChannelEmotes {
        merged,
        others,
        seventv_set,
    }
}

/// Which providers to ask, as of now. Read into an owned value: the guard
/// can't be held across the awaits that follow.
fn providers(state: &AppState) -> Providers {
    Providers::from(&*state.preferences.read())
}

fn store_global_catalog(app: &AppHandle, state: &Arc<AppState>, fresh: catalog::ProviderSets) {
    let app = app.clone();
    let state = Arc::clone(state);
    tauri::async_runtime::spawn_blocking(move || state.emote_catalogs.store_global(&app, &fresh));
}

fn store_channel_catalog(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: String,
    fresh: catalog::ProviderSets,
) {
    let app = app.clone();
    let state = Arc::clone(state);
    tauri::async_runtime::spawn_blocking(move || {
        state.emote_catalogs.store_channel(&app, &room_id, &fresh)
    });
}

fn store_global_badges(
    app: &AppHandle,
    state: &Arc<AppState>,
    fresh: crate::twitch::badges::BadgeMap,
) {
    let app = app.clone();
    let state = Arc::clone(state);
    tauri::async_runtime::spawn_blocking(move || state.badge_cache.store_global(&app, &fresh));
}

fn store_channel_badges(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: String,
    fresh: crate::twitch::badges::BadgeMap,
) {
    let app = app.clone();
    let state = Arc::clone(state);
    tauri::async_runtime::spawn_blocking(move || {
        state.badge_cache.store_channel(&app, &room_id, &fresh)
    });
}

/// Put a complete cached global snapshot in place before restored sockets are
/// opened. It is still refreshed after token validation; this only removes the
/// cold-start gap in which messages cannot resolve global third-party emotes.
pub fn load_cached_global_emotes(state: &Arc<AppState>) {
    let providers = providers(state);
    let cached = state.emote_catalogs.global();
    let complete = cached.complete_for(providers);
    *state.global_emotes.write() = cached.global_map(providers);
    if complete {
        state.global_emotes_ready.store(true, Ordering::Release);
    }
}

/// Fetch the global emote sets and global Twitch badges. Safe to call again
/// after login, or after the enabled providers change.
pub async fn load_global_assets(app: AppHandle, state: Arc<AppState>) {
    // Twitch art remains authenticated behavior: a disk snapshot is useful
    // only while some account can still refresh it. Install it before any
    // network work so restored messages have definitions immediately.
    if state.auth.read().any_credentials().is_some() {
        if let Some(cached) = state.badge_cache.global() {
            *state.global_badges.write() = cached;
        }
    }

    let providers = providers(&state);
    let cached = state.emote_catalogs.global();
    let fresh = fetch_global_emotes(&state, providers).await;
    let emotes = fresh.clone().with_fallback(cached).global_map(providers);
    store_global_catalog(&app, &state, fresh);
    if providers == self::providers(&state) {
        *state.global_emotes.write() = emotes;
        state.global_emotes_ready.store(true, Ordering::Release);
    }

    // Badge *images* are the same whoever asks, so any account's token will
    // do -- which is what keeps them working while the tab you're looking at
    // is anonymous.
    let credentials = { state.auth.read().any_credentials() };
    if let Some((client_id, token)) = credentials {
        let fetch = badges::fetch_global(&state.http, &client_id, &token);
        if let Ok(Ok(map)) = timeout(ASSET_TIMEOUT, fetch).await {
            *state.global_badges.write() = map.clone();
            store_global_badges(&app, &state, map);
        }
    }

    // Twitch's global emotes include what each account subscribes to, so
    // unlike badges these are asked for once per account. Autocomplete only --
    // Twitch emotes in incoming messages are resolved from each message's own
    // `emotes` tag, not from this list.
    let accounts: Vec<String> = {
        state
            .auth
            .read()
            .accounts
            .iter()
            .map(|account| account.id.clone())
            .collect()
    };
    for id in accounts {
        let Some((client_id, token)) = ({ state.auth.read().credentials(&id) }) else {
            continue;
        };
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

    trim_image_cache(&app, &state);
}

/// Enforce the image-cache budget, evicting images outside the current working
/// set before anything an open channel can still reach. Runs off the hot path:
/// it scans a directory, and nothing is waiting on the result.
///
/// Only once every joined channel's emotes have landed, and the global set with
/// them: that gives trimming the complete active set to prioritize.
fn trim_image_cache(app: &AppHandle, state: &Arc<AppState>) {
    if !state.emote_sets_are_loaded() {
        return;
    }

    let app = app.clone();
    let active = state.active_cache_keys();
    tauri::async_runtime::spawn_blocking(move || cache::trim(&app, &active));
}

async fn fetch_channel_badges(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: &str,
) -> crate::twitch::badges::BadgeMap {
    let credentials = { state.auth.read().any_credentials() };
    match credentials {
        Some((client_id, token)) => {
            let cached = state.badge_cache.channel(room_id).unwrap_or_default();
            let fetch = badges::fetch_channel(&state.http, &client_id, &token, room_id);
            match timeout(ASSET_TIMEOUT, fetch).await {
                Ok(Ok(map)) => {
                    store_channel_badges(app, state, room_id.to_string(), map.clone());
                    map
                }
                _ => cached,
            }
        }
        None => Default::default(),
    }
}

fn install_channel_emotes(
    state: &AppState,
    channel: &str,
    room_id: &str,
    emotes: ChannelEmotes,
    expected_revision: Option<u64>,
) -> Option<u64> {
    let mut data = state.data.write();
    let entry = data.get_mut(channel)?;
    if entry.room_id.as_deref() != Some(room_id) {
        return None;
    }
    if expected_revision.is_some_and(|revision| entry.emote_revision != revision) {
        return None;
    }
    entry.emotes = emotes.merged;
    entry.other_emotes = emotes.others;
    entry.seventv_set = emotes.seventv_set;
    entry.emote_revision = entry.emote_revision.wrapping_add(1);
    Some(entry.emote_revision)
}

fn emit_channel_emotes(app: &AppHandle, state: &AppState, channel: &str) {
    let count = state
        .data
        .read()
        .get(channel)
        .map(|data| data.emotes.len())
        .unwrap_or(0);
    let _ = app.emit(
        "chat://emote-set",
        json!({ "channel": channel, "emoteCount": count }),
    );
}

async fn refresh_channel_emotes(
    app: AppHandle,
    state: Arc<AppState>,
    channel: String,
    room_id: String,
    providers: Providers,
    cached: catalog::ProviderSets,
    expected_revision: u64,
) {
    let fresh = fetch_channel_emotes(&state, providers, &room_id).await;
    let effective = fresh.clone().with_fallback(cached);
    store_channel_catalog(&app, &state, room_id.clone(), fresh);
    if providers != self::providers(&state) {
        return;
    }
    if install_channel_emotes(
        &state,
        &channel,
        &room_id,
        channel_emotes(effective, providers),
        Some(expected_revision),
    )
    .is_some()
    {
        state.seventv_events.notify_one();
        emit_channel_emotes(&app, &state, &channel);
        trim_image_cache(&app, &state);
    }
}

/// Load the room-owned half once even when multiple account sockets receive
/// ROOMSTATE together. A complete persisted catalog is installed immediately;
/// its provider refresh continues in the background while badges load.
async fn ensure_channel_assets(
    app: &AppHandle,
    state: &Arc<AppState>,
    channel: &str,
    room_id: &str,
) {
    let lock = state.channel_asset_lock(channel);
    let _guard = lock.lock().await;
    if state
        .data
        .read()
        .get(channel)
        .is_some_and(|data| data.assets_ready && data.room_id.as_deref() == Some(room_id))
    {
        return;
    }

    let providers = providers(state);
    let cached = state.emote_catalogs.channel(room_id);
    let complete_cache = cached
        .as_ref()
        .is_some_and(|sets| sets.complete_for(providers))
        || (!providers.ffz && !providers.bttv && !providers.seventv);

    if complete_cache {
        let cached = cached.unwrap_or_default();
        let Some(revision) = install_channel_emotes(
            state,
            channel,
            room_id,
            channel_emotes(cached.clone(), providers),
            None,
        ) else {
            return;
        };
        state.seventv_events.notify_one();

        crate::diagnostics::supervise(
            format!("emote refresh (#{channel})"),
            refresh_channel_emotes(
                app.clone(),
                Arc::clone(state),
                channel.to_string(),
                room_id.to_string(),
                providers,
                cached,
                revision,
            ),
        );

        let badge_map = fetch_channel_badges(app, state, room_id).await;
        let mut data = state.data.write();
        let Some(entry) = data.get_mut(channel) else {
            return;
        };
        if entry.room_id.as_deref() != Some(room_id) {
            return;
        }
        entry.badges = badge_map;
        entry.assets_ready = true;
        return;
    }

    let cached = cached.unwrap_or_default();
    let (fresh, badge_map) = tokio::join!(
        fetch_channel_emotes(state, providers, room_id),
        fetch_channel_badges(app, state, room_id),
    );
    let effective = fresh.clone().with_fallback(cached);
    store_channel_catalog(app, state, room_id.to_string(), fresh);

    if install_channel_emotes(
        state,
        channel,
        room_id,
        channel_emotes(effective, providers),
        None,
    )
    .is_none()
    {
        return;
    }
    let mut data = state.data.write();
    let Some(entry) = data.get_mut(channel) else {
        return;
    };
    if entry.room_id.as_deref() != Some(room_id) {
        return;
    }
    entry.badges = badge_map;
    entry.assets_ready = true;
    drop(data);
    state.seventv_events.notify_one();
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
    room_id: String,
    load: SessionLoad,
) {
    let SessionLoad {
        account,
        channel,
        connection_generation,
        load_generation,
    } = load;
    ensure_channel_assets(&app, &state, &channel, &room_id).await;

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

    let emote_count = state
        .data
        .read()
        .get(&channel)
        .map(|data| data.emotes.len())
        .unwrap_or(0);
    let key = (account.clone(), channel.clone());
    {
        // Keep the session write-locked and unready until every queued line is
        // in the sink. The socket cannot observe `ready` halfway through and
        // interleave a new line above the remaining history.
        let mut sessions = state.sessions.write();
        // The tab may have been closed while its network requests were in flight.
        let Some(session) = sessions.get_mut(&key) else {
            return;
        };
        if !load_is_current(session, connection_generation, load_generation) {
            return;
        }
        session.twitch_emotes = twitch_emote_names;
        let pending = std::mem::take(&mut session.pending);
        // Where a later reconnect starts looking, set from everything about
        // to go on screen rather than from the live messages alone: a channel
        // that says nothing between the join and the drop would otherwise
        // have no mark at all, and recover its whole history as though none
        // of it had been seen.
        let newest = backlog
            .iter()
            .chain(pending.iter())
            .map(render::timestamp)
            .max();
        if let Some(newest) = newest {
            session.last_seen.fetch_max(newest, Ordering::Relaxed);
        }

        // The history runs up to now and `pending` starts partway through it,
        // so the two overlap by however long the fetches took. Twitch's
        // message ids settle it exactly.
        for message in initial_join_messages(&backlog, &pending) {
            render_and_queue(&state, &sink, &account, &channel, message);
        }
        session.loading = false;
        session.interrupted_at = None;
        session.ready = true;
    }

    let _ = app.emit(
        "chat://channel-ready",
        json!({ "account": account, "channel": channel, "emoteCount": emote_count }),
    );

    trim_image_cache(&app, &state);
}

/// Pick one channel back up after its account's socket came back: fetch what
/// was said while it was down, and say so.
///
/// The shape is the join's, and for the same reason -- the session is held
/// un-ready while the history is fetched, so what was missed lands *above*
/// the live messages that have started arriving rather than after them, and
/// the whole gap reads in order. What differs is where it starts: the join
/// replays whatever the service has, this replays only what is newer than the
/// last message this session actually queued, so nothing already on screen
/// comes back twice.
///
/// The history service is the same third party the join uses, so the same
/// preference governs it. Off, this is only the line saying we're back.
async fn resume_channel(state: Arc<AppState>, sink: MessageSink, since: i64, load: SessionLoad) {
    let SessionLoad {
        account,
        channel,
        connection_generation,
        load_generation,
    } = load;
    let wants_history = state.preferences.read().show_message_history;
    let backlog = match wants_history {
        true => timeout(HISTORY_TIMEOUT, history::fetch(&state.http, &channel))
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or_default(),
        false => Vec::new(),
    };

    let key = (account.clone(), channel.clone());
    let (recovered_len, backlog_len) = {
        let mut sessions = state.sessions.write();
        // Parted while we were asking -- there's no view left to fill in.
        let Some(session) = sessions.get_mut(&key) else {
            return;
        };
        if !load_is_current(session, connection_generation, load_generation) {
            return;
        }
        let pending = std::mem::take(&mut session.pending);

        // The socket came back before the fetch did, so the newest of what the
        // service has is also sitting in `pending`. Ids settle the overlap,
        // the same way they do on a join.
        let live: HashSet<&str> = pending
            .iter()
            .filter_map(|message| message.tag("id"))
            .collect();
        let recovered = missed(&backlog, since, &live);
        let newest = recovered
            .iter()
            .copied()
            .chain(pending.iter())
            .map(render::timestamp)
            .max();
        if let Some(newest) = newest {
            session.last_seen.fetch_max(newest, Ordering::Relaxed);
        }

        // Stay unready, under the write lock, until the recovered and buffered
        // lines are queued in their final order. New socket traffic follows
        // only after this guard is released.
        for message in &recovered {
            render_and_queue(&state, &sink, &account, &channel, message);
        }
        let _ = sink.send(stamped(&account, &channel, resumed(recovered.len())));
        for message in &pending {
            render_and_queue(&state, &sink, &account, &channel, message);
        }
        session.loading = false;
        session.interrupted_at = None;
        session.ready = true;
        (recovered.len(), backlog.len())
    };

    log::info!(
        "resumed #{channel} as {account}: {recovered_len} of {backlog_len} history lines were missed",
    );
}

/// The lines from a history fetch that actually belong in the gap.
///
/// Two ways one doesn't. It can be older than the mark, which means it was on
/// screen before the socket went -- the service answers with the last hundred
/// and fifty lines whatever we're missing, so most of a reply is usually
/// this. Or it can be one the returning socket has already handed us, which
/// is the overlap between "up to now" and "from the moment we were back".
fn missed<'a>(backlog: &'a [IrcMessage], since: i64, live: &HashSet<&str>) -> Vec<&'a IrcMessage> {
    backlog
        .iter()
        .filter(|message| render::timestamp(message) > since)
        .filter(|message| !message.tag("id").is_some_and(|id| live.contains(id)))
        .collect()
}

/// Say in every channel an account was reading that its socket has gone, and
/// mark each session with where the gap begins.
///
/// Only sessions that were actually up: one still loading has nothing on
/// screen for a gap to interrupt, and a connection that failed on its very
/// first attempt has interrupted nothing. They're marked un-ready as well, so
/// that anything arriving on the new socket waits for the missed messages to
/// be placed above it.
fn announce_drop(state: &AppState, sink: &MessageSink, account: &str, connection_generation: u64) {
    let mut sessions = state.sessions.write();
    for ((id, channel), session) in sessions.iter_mut() {
        if id != account || session.connection_generation != connection_generation {
            continue;
        }
        if !session.ready {
            // Any asset/history task belongs to the dead socket attempt. Its
            // result is ignored and ROOMSTATE on the replacement starts anew.
            if session.loading {
                session.load_generation = session.load_generation.wrapping_add(1);
                session.loading = false;
            }
            continue;
        }
        // A channel that hasn't said a word since the join has no message to
        // measure from, so the gap starts now. Our clock rather than
        // Twitch's, which is the one case where the two have to agree.
        session.interrupted_at = Some(match session.last_seen.load(Ordering::Relaxed) {
            0 => render::now_ms(),
            seen => seen,
        });
        session.ready = false;
        let _ = sink.send(stamped(account, channel, DROPPED));
    }
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

    let cached_global = state.emote_catalogs.global();
    *state.global_emotes.write() = cached_global.clone().global_map(providers);
    let fresh_global = fetch_global_emotes(&state, providers).await;
    let global = fresh_global
        .clone()
        .with_fallback(cached_global)
        .global_map(providers);
    store_global_catalog(&app, &state, fresh_global);
    if providers != self::providers(&state) {
        return;
    }
    *state.global_emotes.write() = global;
    state.global_emotes_ready.store(true, Ordering::Release);

    let rooms: Vec<(String, String)> = state
        .data
        .read()
        .iter()
        .filter_map(|(channel, data)| {
            data.room_id
                .clone()
                .map(|room_id| (channel.clone(), room_id))
        })
        .collect();

    for (channel, room_id) in rooms {
        let cached = state.emote_catalogs.channel(&room_id).unwrap_or_default();
        if cached.complete_for(providers) {
            install_channel_emotes(
                &state,
                &channel,
                &room_id,
                channel_emotes(cached.clone(), providers),
                None,
            );
        }
        let fresh = fetch_channel_emotes(&state, providers, &room_id).await;
        let effective = fresh.clone().with_fallback(cached);
        store_channel_catalog(&app, &state, room_id.clone(), fresh);
        if providers != self::providers(&state) {
            return;
        }
        install_channel_emotes(
            &state,
            &channel,
            &room_id,
            channel_emotes(effective, providers),
            None,
        );
    }

    // Switching 7TV off leaves no set to watch, which is what closes the event
    // socket; switching it back on is what opens one.
    state.seventv_events.notify_one();

    // The frontend rebuilds every channel's completion index off this, which
    // is exactly what a changed provider set needs.
    let _ = app.emit(
        "chat://assets",
        json!({
            "globalEmotes": state.global_emotes.read().len(),
            "globalBadges": state.global_badges.read().len(),
        }),
    );

    trim_image_cache(&app, &state);
}

fn handle_line(
    app: &AppHandle,
    state: &Arc<AppState>,
    sink: &MessageSink,
    account: &str,
    connection_generation: u64,
    line: &str,
) -> Option<String> {
    let msg = parse::parse(line)?;

    // A replacement can be installed before the old socket task observes its
    // Shutdown command. It may still receive a final frame, but it no longer
    // owns any session state or UI events.
    if msg.command != "PING" && !connection_is_current(state, account, connection_generation) {
        return None;
    }

    match msg.command.as_str() {
        "PING" => {
            let token = msg.params.first().cloned().unwrap_or_default();
            return Some(format!("PONG :{token}"));
        }
        "RECONNECT" => {
            // Signalled by the caller via a dedicated marker line.
            emit_status(
                app,
                account,
                "reconnecting",
                Some("Twitch asked us to reconnect".into()),
            );
        }
        "PRIVMSG" | "USERNOTICE" => {
            let channel = msg.channel()?;

            let key = (account.to_string(), channel.clone());
            let ready = {
                let sessions = state.sessions.read();
                match sessions.get(&key) {
                    Some(session) if session.connection_generation == connection_generation => {
                        // Where the next reconnect will start looking. Under
                        // this guard rather than its own, since it's written
                        // for every message that arrives.
                        session
                            .last_seen
                            .fetch_max(render::timestamp(&msg), Ordering::Relaxed);
                        session.ready
                    }
                    Some(_) | None => false,
                }
            };
            if ready {
                render_and_queue(state, sink, account, &channel, &msg);
            } else {
                // Hold the message until emotes and history land so it renders
                // correctly and in order. Recheck readiness under the write
                // lock: the join may have completed after the read above.
                let mut sessions = state.sessions.write();
                let session = session_for_generation(&mut sessions, key, connection_generation);
                session
                    .last_seen
                    .fetch_max(render::timestamp(&msg), Ordering::Relaxed);
                if session.ready {
                    drop(sessions);
                    render_and_queue(state, sink, account, &channel, &msg);
                } else if session.pending.len() < MAX_PENDING {
                    session.pending.push(msg);
                }
            }
        }
        "USERSTATE" => {
            let channel = msg.channel()?;
            let role = ChannelRole::of(&msg);

            // Twitch repeats USERSTATE after every message we send, so only a
            // real change is worth waking the UI for.
            let changed = {
                let mut sessions = state.sessions.write();
                let session = session_for_generation(
                    &mut sessions,
                    (account.to_string(), channel.clone()),
                    connection_generation,
                );
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
            let channel = msg.channel()?;
            // ROOMSTATE carries room-id, which is the broadcaster's Twitch user id.
            // That's exactly what 7TV and the Helix badge endpoint need, and it
            // saves us an authenticated user lookup.
            let room_id = msg.tag("room-id").map(str::to_string)?;

            // Per session, not per channel: a second account joining a room
            // the first is already in still needs its own backlog and its own
            // emotes, even though the room's sets are already in hand.
            let load = {
                state
                    .data
                    .write()
                    .entry(channel.clone())
                    .or_default()
                    .room_id = Some(room_id.clone());
                let mut sessions = state.sessions.write();
                let session = session_for_generation(
                    &mut sessions,
                    (account.to_string(), channel.clone()),
                    connection_generation,
                );
                if session.loading || session.ready {
                    None
                } else {
                    let since = session.interrupted_at;
                    let load_generation = state
                        .next_session_load_generation
                        .fetch_add(1, Ordering::Relaxed);
                    Some((since, begin_load(session, load_generation)))
                }
            };

            let _ = app.emit(
                "chat://roomstate",
                json!({ "channel": channel, "roomId": room_id }),
            );

            // A rejoin rather than a join: the room's assets and this
            // session's emotes are still in hand, and the only thing missing
            // is whatever was said while the socket was down. Checked first
            // because a dropped session is also not ready, and running the
            // whole join would re-ask Twitch for emotes it already has and
            // replay a backlog that's already on screen.
            if let Some((Some(since), load_generation)) = load {
                crate::diagnostics::supervise(
                    format!("resume ({account} in #{channel})"),
                    resume_channel(
                        Arc::clone(state),
                        sink.clone(),
                        since,
                        SessionLoad {
                            account: account.to_string(),
                            channel,
                            connection_generation,
                            load_generation,
                        },
                    ),
                );
            } else if let Some((None, load_generation)) = load {
                crate::diagnostics::supervise(
                    format!("channel assets ({account} in #{channel})"),
                    load_channel_assets(
                        app.clone(),
                        Arc::clone(state),
                        sink.clone(),
                        room_id,
                        SessionLoad {
                            account: account.to_string(),
                            channel,
                            connection_generation,
                            load_generation,
                        },
                    ),
                );
            }
        }
        "CLEARCHAT" => {
            let channel = msg.channel()?;
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
            let channel = msg.channel()?;
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
    connection_generation: u64,
    rx: &mut mpsc::UnboundedReceiver<IrcCommand>,
) -> anyhow::Result<Outcome> {
    if !connection_is_current(state, account, connection_generation) {
        return Ok(Outcome::Done);
    }
    emit_status(app, account, "connecting", None);

    let (stream, _) = connect_async(GATEWAY).await?;
    let (mut write, mut read) = stream.split();

    // Anonymous read-only login unless this connection belongs to an account.
    // An account whose token has gone (signed out from under it) falls back to
    // anonymous rather than failing: the tab keeps reading.
    let (nick, pass) = {
        let auth = state.auth.read();
        match auth.account(account) {
            Some(account) => (
                account.login.clone(),
                format!("oauth:{}", account.access_token),
            ),
            None => {
                let suffix: u32 = rand::thread_rng().gen_range(10_000..99_999);
                (format!("justinfan{suffix}"), "SCHMOOPIIE".to_string())
            }
        }
    };

    // Skip twitch.tv/membership: it floods JOIN/PART on large channels and we
    // don't render a user list.
    write
        .send(Message::Text(
            "CAP REQ :twitch.tv/tags twitch.tv/commands".into(),
        ))
        .await?;
    write
        .send(Message::Text(format!("PASS {pass}").into()))
        .await?;
    write
        .send(Message::Text(format!("NICK {nick}").into()))
        .await?;

    // What this account's tabs ask for, as of now. Clone first: the guard must
    // not be held across an await.
    let joined: Vec<String> = state
        .connections
        .read()
        .get(account)
        .filter(|connection| connection.generation == connection_generation)
        .map(|connection| connection.joined.iter().cloned().collect())
        .unwrap_or_default();
    for channel in joined {
        write
            .send(Message::Text(format!("JOIN #{channel}").into()))
            .await?;
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
                            if let Some(reply) = handle_line(
                                app,
                                state,
                                sink,
                                account,
                                connection_generation,
                                line,
                            ) {
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
    connection_generation: u64,
    mut rx: mpsc::UnboundedReceiver<IrcCommand>,
) {
    let mut backoff_secs = 1u64;

    loop {
        match connect_once(
            &app,
            &state,
            &sink,
            &account,
            connection_generation,
            &mut rx,
        )
        .await
        {
            Ok(Outcome::Done) => break,
            Ok(Outcome::Reconnect) => backoff_secs = 1,
            Err(error) => {
                if connection_is_current(&state, &account, connection_generation) {
                    emit_status(&app, &account, "disconnected", Some(error.to_string()));
                }
            }
        }

        if !connection_is_current(&state, &account, connection_generation) {
            break;
        }

        // Everything below this point is a connection that ended and will be
        // tried again -- a deliberate shutdown has already broken out of the
        // loop, and says nothing.
        announce_drop(&state, &sink, &account, connection_generation);

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }

    // Whatever was buffered for this account is nobody's now.
    state.sessions.write().retain(|(id, _), session| {
        id != &account || session.connection_generation != connection_generation
    });
    if !state.connections.read().contains_key(&account) {
        emit_status(&app, &account, "closed", None);
    }
}

/// Bring the connections in line with the tabs.
///
/// The one place sockets are created or destroyed: every tab change (opened,
/// closed, reassigned to another account, or an account removed under it) ends
/// here, and the diff decides what actually has to happen. Idempotent, so a
/// caller that isn't sure whether anything changed can simply call it.
pub fn sync(app: &AppHandle, state: &Arc<AppState>) {
    let Some(sink) = ({ state.sink.read().clone() }) else {
        return;
    };
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
            let generation = state
                .next_connection_generation
                .fetch_add(1, Ordering::Relaxed);
            crate::diagnostics::supervise(
                format!("irc socket ({account})"),
                run(
                    app.clone(),
                    Arc::clone(state),
                    sink.clone(),
                    account.clone(),
                    generation,
                    rx,
                ),
            );
            Connection {
                commands: tx,
                generation,
                joined: HashSet::new(),
            }
        });

        for channel in channels.difference(&connection.joined) {
            let _ = connection.commands.send(IrcCommand::Join(channel.clone()));
        }
        for channel in connection.joined.difference(&channels) {
            let _ = connection.commands.send(IrcCommand::Part(channel.clone()));
            // Its buffered messages and role go with it: coming back is a
            // fresh join, backlog and all.
            state
                .sessions
                .write()
                .remove(&(account.clone(), channel.clone()));
        }
        connection.joined = channels;
    }
    drop(connections);

    // A channel no tab is on any more keeps no live state: its persisted emote
    // catalog can seed the next join, and its recently used images remain only
    // while the bounded cache has room for them.
    let open = state.open_channels();
    state
        .data
        .write()
        .retain(|channel, _| open.contains(channel));
    // Whatever sets just left with those channels aren't worth a subscription.
    state.seventv_events.notify_one();
}

/// Drop and rebuild every connection -- after a sign-in, a sign-out, or a
/// Client ID change, all of which change who a socket is logged in as.
pub fn reconnect_all(state: &Arc<AppState>) {
    for connection in state.connections.read().values() {
        let _ = connection.commands.send(IrcCommand::Reconnect);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_connection_replaces_a_stale_session() {
        let key = ("account".to_string(), "channel".to_string());
        let mut sessions = HashMap::new();
        let old = session_for_generation(&mut sessions, key.clone(), 1);
        old.ready = true;
        old.pending.push(line("old", 1));

        let replacement = session_for_generation(&mut sessions, key, 2);
        assert_eq!(replacement.connection_generation, 2);
        assert!(!replacement.ready);
        assert!(replacement.pending.is_empty());
    }

    #[test]
    fn only_the_latest_loader_can_finish_a_session() {
        let mut session = Session {
            connection_generation: 7,
            ..Default::default()
        };
        let first = begin_load(&mut session, 11);
        assert!(load_is_current(&session, 7, first));
        let second = begin_load(&mut session, 12);
        assert!(!load_is_current(&session, 7, first));
        assert!(load_is_current(&session, 7, second));
        assert!(!load_is_current(&session, 8, second));
    }

    fn line(id: &str, ts: i64) -> IrcMessage {
        parse::parse(&format!(
            "@id={id};tmi-sent-ts={ts} :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hi"
        ))
        .expect("a parseable line")
    }

    fn historical_line(id: &str, ts: i64) -> IrcMessage {
        parse::parse(&format!(
            "@historical=1;id={id};tmi-sent-ts={ts} :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hi"
        ))
        .expect("a parseable historical line")
    }

    #[test]
    fn initial_history_precedes_live_and_overlap_prefers_the_live_copy() {
        let backlog = [
            historical_line("old", 1_000),
            historical_line("both", 2_000),
        ];
        let pending = [line("both", 2_000), line("new", 3_000)];

        let joined = initial_join_messages(&backlog, &pending);
        let ids: Vec<&str> = joined
            .iter()
            .filter_map(|message| message.tag("id"))
            .collect();
        assert_eq!(ids, ["old", "both", "new"]);
        assert_eq!(joined[1].tag("historical"), None, "the live duplicate wins");
    }

    #[test]
    fn only_what_the_gap_actually_holds_is_recovered() {
        let backlog = [
            line("old", 1_000),
            line("gap-1", 2_000),
            line("gap-2", 3_000),
        ];
        let live = HashSet::new();

        // The mark is the last message that was on screen, so it is not
        // itself missed -- `>` rather than `>=`, or every reconnect repeats a
        // line you were looking at.
        let recovered = missed(&backlog, 1_000, &live);
        let ids: Vec<&str> = recovered.iter().filter_map(|m| m.tag("id")).collect();
        assert_eq!(ids, ["gap-1", "gap-2"]);

        assert!(
            missed(&backlog, 3_000, &live).is_empty(),
            "nothing said while we were away"
        );
    }

    #[test]
    fn what_the_returning_socket_already_delivered_is_not_recovered() {
        // The history runs up to now and the new connection started partway
        // through it, so the two overlap by however long the fetch took.
        let backlog = [line("gap", 2_000), line("both", 3_000)];
        let live = HashSet::from(["both"]);

        let ids: Vec<&str> = missed(&backlog, 1_000, &live)
            .iter()
            .filter_map(|m| m.tag("id"))
            .collect();
        assert_eq!(ids, ["gap"]);
    }

    #[test]
    fn the_line_says_how_much_came_back() {
        assert_eq!(resumed(0), "Reconnected");
        assert_eq!(resumed(1), "Reconnected -- 1 message recovered");
        assert_eq!(resumed(12), "Reconnected -- 12 messages recovered");
    }

    #[test]
    fn a_notice_the_app_wrote_is_addressed_like_any_other_message() {
        // Unstamped it would land in whichever tab of that account you were
        // reading, rather than in the channel it's about.
        let notice = stamped("1234", "forsen", DROPPED);
        assert_eq!(notice.account, "1234");
        assert_eq!(notice.channel, "forsen");
        assert_eq!(notice.kind, "notice");
        assert_eq!(notice.system_message.as_deref(), Some(DROPPED));
    }
}
