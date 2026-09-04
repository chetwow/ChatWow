//! Shared application state.

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::emotes::Emote;
use crate::irc::parse::IrcMessage;
use crate::settings::{Account, Tab, ANONYMOUS};
use crate::twitch::badges::BadgeMap;
use crate::twitch::emotes::TwitchEmote;

/// Commands sent from Tauri command handlers into one account's IRC task.
#[derive(Debug, Clone)]
pub enum IrcCommand {
    Join(String),
    Part(String),
    /// Drop and rebuild the connection, e.g. after signing in.
    Reconnect,
    /// Close for good: this account has no tabs left, or has been removed.
    Shutdown,
}

/// One account's socket, and what it has been told to be in.
pub struct Connection {
    pub commands: mpsc::UnboundedSender<IrcCommand>,
    pub generation: u64,
    /// The channels this socket is in. Held here rather than in the task so
    /// that reconciling tabs against connections is a set comparison, and so a
    /// reconnect rejoins exactly what the tabs still ask for.
    pub joined: HashSet<String>,
}

/// What one account is doing in one channel: its own view of a room.
///
/// Separate from `ChannelData` because these are the parts that genuinely
/// differ per account -- when *its* connection finished loading, what it was
/// holding meanwhile, whether it can moderate here, and which of Twitch's
/// emotes it owns. Everything in `ChannelData` is a property of the room and
/// is shared by every account watching it.
#[derive(Debug, Default)]
pub struct Session {
    pub connection_generation: u64,
    pub load_generation: u64,
    pub loading: bool,
    /// Gates rendering until this account's join has assets and backlog.
    pub ready: bool,
    /// Messages received before that finished.
    pub pending: Vec<IrcMessage>,
    /// The `tmi-sent-ts` of the newest message this session has queued. Where
    /// a reconnect starts looking for what it missed, so that nothing already
    /// on screen comes back a second time.
    ///
    /// An atomic because it's written for every message that arrives, and can
    /// therefore go under the read guard the readiness check already takes --
    /// a write lock per message would be a real cost on a busy channel.
    pub last_seen: AtomicI64,
    /// Where the gap starts, when this session's socket has gone and what it
    /// missed hasn't been fetched back yet. `None` the rest of the time.
    ///
    /// Frozen at the drop rather than read at the rejoin: live messages start
    /// arriving the moment we're back, and reading `last_seen` then would put
    /// the mark on the far side of the very gap it's meant to open.
    pub interrupted_at: Option<i64>,
    /// What we are here, from our own USERSTATE. Decides which commands the
    /// picker offers -- there's no Helix endpoint that answers "am I a mod in
    /// this channel", so this tag is the only source. Per account by nature:
    /// one of your logins can be a mod here and another not.
    pub role: crate::irc::parse::ChannelRole,
    /// Twitch's own emotes for this account in this channel -- completion
    /// fodder, deliberately not part of `ChannelData::emotes` (see
    /// `twitch::emotes`). Per account because subscriber emotes are.
    pub twitch_emotes: Vec<TwitchEmote>,
}

/// A session key: which account, in which channel.
pub type SessionKey = (String, String);

#[derive(Debug, Clone, Default)]
pub struct Auth {
    /// A Client ID the user deliberately set in the account dialog, replacing
    /// the compiled-in one. Deliberately a different settings key from the old
    /// `client_id`, so a file left by an earlier build can't supply one: an
    /// override only ever exists because someone asked for it in this build.
    pub client_id_override: Option<String>,
    /// Every signed-in account. One Client ID covers all of them -- it
    /// identifies the *app*, not the user -- so this is a list of tokens, not
    /// of apps.
    pub accounts: Vec<Account>,
    /// Which account a newly opened tab reads as. `ANONYMOUS` for none.
    pub default_account: String,
    /// The optional permission groups the next sign-in will ask for. Shared:
    /// it's what to *request*, where what each account was actually granted
    /// rides on that account.
    pub permission_groups: Vec<String>,
}

impl Auth {
    /// The Client ID to actually use.
    ///
    /// An explicit override wins, so a user is never stranded if the shipped
    /// Twitch app is suspended or rate-limited -- without one there'd be no way
    /// out of a broken build short of shipping a new release. A *stale* file
    /// still can't redirect anything: see `client_id_override`.
    pub fn client_id(&self) -> Option<&str> {
        self.client_id_override
            .as_deref()
            .or(crate::auth::BUILT_IN_CLIENT_ID)
    }

    pub fn account(&self, id: &str) -> Option<&Account> {
        if id == ANONYMOUS {
            return None;
        }
        self.accounts.iter().find(|account| account.id == id)
    }

    /// Whether an account's token carries a scope. Answered from the token
    /// rather than from which permission groups are ticked: a group turned on
    /// after signing in isn't granted until the next sign-in.
    pub fn has_scope(&self, id: &str, scope: &str) -> bool {
        self.account(id)
            .is_some_and(|a| a.scopes.iter().any(|held| held == scope))
    }

    /// Client id + token for one account, present only when we can call Helix
    /// as it. Anonymous has none, which is not an error -- it's a tab that
    /// reads and doesn't send.
    pub fn credentials(&self, id: &str) -> Option<(String, String)> {
        match (self.client_id(), self.account(id)) {
            (Some(client_id), Some(account)) => {
                Some((client_id.to_string(), account.access_token.clone()))
            }
            _ => None,
        }
    }

    /// Credentials for *any* account, preferring the default one.
    ///
    /// For the calls that ask Twitch about the world rather than about you --
    /// badge images, who's live, channel search, a link preview. Any token
    /// answers those identically, so needing a particular one would mean a
    /// signed-in app losing them the moment a tab went anonymous.
    pub fn any_credentials(&self) -> Option<(String, String)> {
        self.credentials(&self.default_account).or_else(|| {
            self.accounts
                .first()
                .map(|a| (a.id.clone(), a.access_token.clone()))
                .and_then(|(id, _)| self.credentials(&id))
        })
    }
}

/// One account as the frontend sees it: everything but the tokens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub login: String,
    /// What this account's token actually allows.
    pub scopes: Vec<String>,
    /// Twitch's profile picture for this account. Empty when Twitch has none
    /// or hasn't answered yet, which the accounts list draws as a monogram.
    pub avatar_url: String,
}

/// What the UI needs to know about the auth state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_client_id: bool,
    /// The override in force, if any. `None` means the compiled-in Client ID,
    /// which is the normal case.
    pub client_id_override: Option<String>,
    /// Every signed-in account. Empty is the ordinary signed-out state, where
    /// every tab reads anonymously.
    pub accounts: Vec<AccountInfo>,
    /// Which account new tabs get.
    pub default_account: String,
    /// The optional permission groups the next sign-in will ask for.
    pub permission_groups: Vec<String>,
    /// The groups themselves -- ids, labels and what each one is for. Static,
    /// but it travels with the status so the account panel has one source for
    /// what to draw and what's been granted.
    pub permission_catalog: &'static [crate::auth::PermissionGroup],
}

/// What a channel is, as opposed to what an account is doing in it: the room
/// id, and the emotes and badges every account watching it renders with.
#[derive(Debug, Default)]
pub struct ChannelData {
    pub room_id: Option<String>,
    /// Whether the emote and badge sets have landed. Fetched once per channel
    /// however many accounts are in it -- they're the same sets either way.
    pub assets_ready: bool,
    /// Every provider's channel set, merged -- what the renderer looks in.
    pub emotes: HashMap<String, Emote>,
    /// FFZ's and BTTV's halves of that merge, kept on their own. 7TV wins a
    /// shared name, so when one of its emotes is *removed* live the name it
    /// was standing on top of has to come back, and the merged map alone can't
    /// say what that was. Nothing reads this to render.
    pub other_emotes: HashMap<String, Emote>,
    /// The 7TV emote set these emotes came from, when this channel has one.
    /// Only the EventAPI needs it: it's what a subscription names, and what a
    /// change coming back is matched to a channel by.
    pub seventv_set: Option<String>,
    /// Bumped whenever the wholesale provider snapshot or a live 7TV event
    /// changes the map. A slower HTTP refresh must not overwrite a newer event.
    pub emote_revision: u64,
    pub badges: BadgeMap,
}

/// Cap the pre-ready buffer so a hung fetch can't eat memory on a busy channel.
pub const MAX_PENDING: usize = 300;

pub struct AppState {
    pub http: reqwest::Client,
    /// One socket per account with a tab open, keyed by account id
    /// (`ANONYMOUS` for the signed-out one). IRC authenticates per connection,
    /// so reading as two accounts at once is two connections -- there is no
    /// way to do it on one.
    pub connections: RwLock<HashMap<String, Connection>>,
    pub next_connection_generation: AtomicU64,
    /// Unique across the process rather than per session: a channel can be
    /// closed and reopened while its old loader is still in flight, and a
    /// reset per-session counter would let that stale result match again.
    pub next_session_load_generation: AtomicU64,
    /// The open tabs, in bar order. The app's list of what exists: which
    /// channels to be in, and as whom, both fall out of it.
    pub tabs: RwLock<Vec<Tab>>,
    pub data: RwLock<HashMap<String, ChannelData>>,
    /// What each account is doing in each channel it's in.
    pub sessions: RwLock<HashMap<SessionKey, Session>>,
    pub global_emotes: RwLock<HashMap<String, Emote>>,
    /// Unlike map emptiness, this also represents a completed load whose
    /// enabled providers legitimately returned no global emotes.
    pub global_emotes_ready: AtomicBool,
    /// Persisted provider snapshots used immediately while their network
    /// refreshes run. Images themselves live in `emotes::cache`.
    pub emote_catalogs: crate::emotes::catalog::CatalogCache,
    /// One room-asset fetch per channel even when two account sockets receive
    /// ROOMSTATE together.
    pub channel_asset_loads: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Twitch's global emotes per account, same shape as
    /// `Session::twitch_emotes` -- they include what that account subscribes
    /// to, so they're no more shared than a channel's are.
    pub twitch_global_emotes: RwLock<HashMap<String, Vec<TwitchEmote>>>,
    pub global_badges: RwLock<BadgeMap>,
    /// Each open channel's owner avatar, by login. Room-scoped like the emote
    /// sets, but fetched by the live poll rather than on join: it needs a
    /// token, and being signed out is a state a channel can be joined in.
    pub channel_avatars: RwLock<HashMap<String, String>>,
    /// 7TV badges by Twitch user id, for the chatters we've resolved so far.
    /// Sent to the frontend as they land rather than baked into a message:
    /// they arrive after the message that prompted the lookup, and the ones
    /// already rendered are immutable.
    pub seventv_badges: RwLock<HashMap<String, crate::twitch::badges::Badge>>,
    /// Every chatter already asked about, whether or not they had a badge --
    /// "no badge" is an answer, and 7TV shouldn't be asked it twice.
    pub seventv_badges_asked: RwLock<HashSet<String>>,
    /// Queue into the badge resolver. `None` until `setup` starts it.
    pub badge_lookups: RwLock<Option<mpsc::UnboundedSender<String>>>,
    /// How often each emote name has been sent, across every channel, kept in
    /// the settings file so completion ranking survives a restart.
    pub emote_uses: RwLock<HashMap<String, u32>>,
    /// Everything the settings dialog edits, mirrored into the settings file
    /// on every change so a crash can't lose a toggle.
    pub preferences: RwLock<crate::settings::Preferences>,
    /// The build whose bundled changelog entry the user has acknowledged.
    pub last_seen_version: RwLock<String>,
    pub settings_write: parking_lot::Mutex<()>,
    pub auth: RwLock<Auth>,
    /// Logins currently broadcasting, refreshed by the live poller. Empty when
    /// signed out, where we simply don't know rather than knowing they're off.
    pub live: RwLock<HashSet<String>>,
    /// Kicks the live poller off its interval, so a channel you just joined
    /// gets its dot now rather than up to a poll period later.
    pub live_poll: tokio::sync::Notify,
    /// Where rendered messages go, once `setup` has built the batcher. Held
    /// here because connections are spawned on demand, from wherever a tab
    /// changed, rather than only at startup.
    pub sink: RwLock<Option<crate::irc::client::MessageSink>>,
    /// Tells the whisper socket its credentials changed: it drops the
    /// connection and comes back with the new token, or idles here when
    /// there's no longer one to listen with.
    pub eventsub_restart: tokio::sync::Notify,
    /// Whether a newer release is out, and the download once one is being
    /// fetched. Snapshot as well as events because the settings dialog can be
    /// opened mid-download -- see `updater`.
    pub updates: crate::updater::Updates,
    /// Tells the 7TV event socket that the emote sets worth watching have
    /// moved -- a channel joined or parted, or 7TV switched off. It re-reads
    /// `seventv_sets` and subscribes or unsubscribes to match.
    pub seventv_events: tokio::sync::Notify,
}

impl AppState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("chatwow/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("failed to build HTTP client");

        Self {
            http,
            connections: RwLock::new(HashMap::new()),
            next_connection_generation: AtomicU64::new(1),
            next_session_load_generation: AtomicU64::new(1),
            tabs: RwLock::new(Vec::new()),
            data: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            global_emotes: RwLock::new(HashMap::new()),
            global_emotes_ready: AtomicBool::new(false),
            emote_catalogs: crate::emotes::catalog::CatalogCache::default(),
            channel_asset_loads: Mutex::new(HashMap::new()),
            twitch_global_emotes: RwLock::new(HashMap::new()),
            global_badges: RwLock::new(BadgeMap::new()),
            channel_avatars: RwLock::new(HashMap::new()),
            seventv_badges: RwLock::new(HashMap::new()),
            seventv_badges_asked: RwLock::new(HashSet::new()),
            badge_lookups: RwLock::new(None),
            emote_uses: RwLock::new(HashMap::new()),
            preferences: RwLock::new(crate::settings::Preferences::default()),
            last_seen_version: RwLock::new(String::new()),
            settings_write: parking_lot::Mutex::new(()),
            auth: RwLock::new(Auth::default()),
            live: RwLock::new(HashSet::new()),
            sink: RwLock::new(None),
            live_poll: tokio::sync::Notify::new(),
            eventsub_restart: tokio::sync::Notify::new(),
            seventv_events: tokio::sync::Notify::new(),
            updates: crate::updater::Updates::new(env!("CARGO_PKG_VERSION").to_string()),
        }
    }

    /// Ask 7TV about a chatter's badge, once. Called for every message that
    /// arrives, so the cheap checks come first: the preference, then whether
    /// this chatter has been asked about before.
    pub fn queue_badge_lookup(&self, user_id: &str) {
        if user_id.is_empty() || !self.preferences.read().show_seventv_badges {
            return;
        }
        if !self
            .seventv_badges_asked
            .write()
            .insert(user_id.to_string())
        {
            return;
        }
        if let Some(tx) = self.badge_lookups.read().as_ref() {
            let _ = tx.send(user_id.to_string());
        }
    }

    /// Tell one account's connection something, if it has one.
    pub fn send(&self, account: &str, command: IrcCommand) {
        if let Some(connection) = self.connections.read().get(account) {
            let _ = connection.commands.send(command);
        }
    }

    /// The 7TV emote sets behind the open channels -- what the event socket
    /// subscribes to. A channel with no 7TV account contributes nothing.
    pub fn seventv_sets(&self) -> HashSet<String> {
        self.data
            .read()
            .values()
            .filter_map(|data| data.seventv_set.clone())
            .collect()
    }

    /// Which accounts have a tab on a channel. What a line the app writes
    /// about the *room* rather than about one login has to be stamped with,
    /// once each, to reach every tab showing that channel.
    pub fn accounts_in(&self, channel: &str) -> HashSet<String> {
        self.tabs
            .read()
            .iter()
            .filter(|tab| tab.is_channel() && tab.channel == channel)
            .map(|tab| tab.account.clone())
            .collect()
    }

    /// Every channel any tab is reading, however many accounts are in each.
    pub fn open_channels(&self) -> HashSet<String> {
        self.tabs
            .read()
            .iter()
            .filter(|tab| tab.is_channel())
            .map(|tab| tab.channel.clone())
            .collect()
    }

    /// What each account needs to be in, from the tabs alone. The one place
    /// connections are derived from tabs; `client::sync` acts on the result.
    pub fn wanted(&self) -> HashMap<String, HashSet<String>> {
        let mut wanted: HashMap<String, HashSet<String>> = HashMap::new();
        for tab in self.tabs.read().iter() {
            if !tab.is_channel() {
                continue;
            }
            wanted
                .entry(tab.account.clone())
                .or_default()
                .insert(tab.channel.clone());
        }
        wanted
    }

    /// Serialize the room-owned half of a join. Two account sockets can learn
    /// the same room id at once, but its provider catalogs and badges need one
    /// fetch and one state update.
    pub fn channel_asset_lock(&self, channel: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.channel_asset_loads
                .lock()
                .entry(channel.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Every emote completable in a channel as one account: the 7TV global and
    /// channel sets, plus that account's own Twitch emotes when signed in.
    pub fn emote_entries(&self, account: &str, channel: &str) -> Vec<EmoteEntry> {
        let mut entries: Vec<EmoteEntry> = self
            .global_emotes
            .read()
            .values()
            .map(EmoteEntry::from_emote)
            .collect();
        if let Some(globals) = self.twitch_global_emotes.read().get(account) {
            entries.extend(globals.iter().map(EmoteEntry::from_twitch));
        }
        if let Some(data) = self.data.read().get(channel) {
            entries.extend(data.emotes.values().map(EmoteEntry::from_emote));
        }
        if let Some(session) = self
            .sessions
            .read()
            .get(&(account.to_string(), channel.to_string()))
        {
            entries.extend(session.twitch_emotes.iter().map(EmoteEntry::from_twitch));
        }
        sort_and_dedupe(entries)
    }

    /// Whether every emote set we expect is in hand: the enabled global sets
    /// and each joined channel's. Only then can image-cache trimming prioritize
    /// the complete active working set. A channel that never loads leaves this
    /// false, which safely postpones maintenance.
    pub fn emote_sets_are_loaded(&self) -> bool {
        if !self
            .global_emotes_ready
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return false;
        }
        let channels = self.open_channels();
        let data = self.data.read();
        channels
            .iter()
            .all(|channel| data.get(channel).is_some_and(|c| c.assets_ready))
    }

    /// Cache keys for the active image working set. These survive trimming
    /// ahead of recently used images from channels that are no longer open.
    pub fn active_cache_keys(&self) -> HashSet<String> {
        let mut keys: HashSet<String> = self
            .global_emotes
            .read()
            .values()
            .map(|e| cache_key(e.provider, &e.id))
            .collect();
        for globals in self.twitch_global_emotes.read().values() {
            keys.extend(globals.iter().map(|e| cache_key("twitch", &e.id)));
        }
        for data in self.data.read().values() {
            keys.extend(data.emotes.values().map(|e| cache_key(e.provider, &e.id)));
        }
        for session in self.sessions.read().values() {
            keys.extend(
                session
                    .twitch_emotes
                    .iter()
                    .map(|e| cache_key("twitch", &e.id)),
            );
        }
        keys
    }

    /// Count emotes that went out in a message. Names we don't recognize are
    /// ignored, so the persisted map only ever holds real emotes. Returns
    /// whether anything changed, i.e. whether settings need rewriting.
    pub fn record_emote_uses(&self, account: &str, channel: &str, names: &[String]) -> bool {
        let known: HashSet<String> = self
            .emote_entries(account, channel)
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        let mut uses = self.emote_uses.write();
        let mut changed = false;
        for name in names.iter().filter(|name| known.contains(*name)) {
            *uses.entry(name.clone()).or_insert(0) += 1;
            changed = true;
        }
        changed
    }

    pub fn auth_status(&self) -> AuthStatus {
        let auth = self.auth.read();
        AuthStatus {
            has_client_id: auth.client_id().is_some(),
            client_id_override: auth.client_id_override.clone(),
            accounts: auth
                .accounts
                .iter()
                .map(|account| AccountInfo {
                    id: account.id.clone(),
                    login: account.login.clone(),
                    scopes: account.scopes.clone(),
                    avatar_url: account.avatar_url.clone(),
                })
                .collect(),
            default_account: auth.default_account.clone(),
            permission_groups: auth.permission_groups.clone(),
            permission_catalog: crate::auth::PERMISSION_GROUPS,
        }
    }
}

/// One completable emote, as the picker and the composer see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmoteEntry {
    /// Provider id -- what the image cache is keyed on, since 7TV names are
    /// routinely aliased per channel.
    pub id: String,
    pub name: String,
    /// CDN url, used directly until the cached copy is on disk.
    pub url: String,
    pub provider: String,
}

impl EmoteEntry {
    fn from_emote(emote: &Emote) -> Self {
        Self {
            id: emote.id.clone(),
            name: emote.name.clone(),
            url: emote.url.clone(),
            provider: emote.provider.to_string(),
        }
    }

    fn from_twitch(emote: &TwitchEmote) -> Self {
        // Twitch image urls follow from the id, so there's nothing to store.
        let resolved = crate::emotes::twitch_emote(&emote.id, &emote.name);
        Self::from_emote(&resolved)
    }
}

/// How an emote's image is named in the on-disk cache. Id-keyed, so renaming
/// (or aliasing) an emote never re-downloads it and two emotes sharing a name
/// stay distinct.
pub fn cache_key(provider: &str, id: &str) -> String {
    format!("{provider}-{id}")
}

/// The same emote can appear in more than one set, so drop duplicates -- by id
/// and name together, since an aliased 7TV emote is a different entry to offer
/// even though it's the same image. Sorted case-insensitively: that's the
/// alphabetical fallback the UI relies on after it floats the more-used emotes
/// to the top of the matches.
fn sort_and_dedupe(mut entries: Vec<EmoteEntry>) -> Vec<EmoteEntry> {
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    entries.dedup_by(|a, b| a.name == b.name && a.id == b.id);
    entries
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn entry(id: &str, name: &str) -> EmoteEntry {
        EmoteEntry {
            id: id.to_string(),
            name: name.to_string(),
            url: format!("https://cdn/{id}"),
            provider: "7tv".to_string(),
        }
    }

    fn names_of(entries: &[EmoteEntry]) -> Vec<String> {
        entries.iter().map(|e| e.name.clone()).collect()
    }

    fn sample_emote() -> Emote {
        Emote {
            id: "abc".to_string(),
            name: "Clap".to_string(),
            url: "https://cdn/abc".to_string(),
            url_large: "https://cdn/abc-4x".to_string(),
            provider: "7tv",
            zero_width: false,
            width: 64,
            height: 64,
        }
    }

    fn kappa() -> TwitchEmote {
        TwitchEmote {
            id: "25".to_string(),
            name: "Kappa".to_string(),
        }
    }

    #[test]
    fn emote_names_are_ordered_case_insensitively() {
        let sorted = sort_and_dedupe(vec![
            entry("a", "Zulul"),
            entry("b", "apu"),
            entry("c", "Bedge"),
        ]);
        assert_eq!(names_of(&sorted), owned(&["apu", "Bedge", "Zulul"]));
    }

    #[test]
    fn an_emote_in_two_sets_is_listed_once() {
        // 7TV channel sets routinely re-add a global emote unchanged.
        let sorted = sort_and_dedupe(vec![
            entry("a", "Clap"),
            entry("b", "peepoHey"),
            entry("a", "Clap"),
        ]);
        assert_eq!(names_of(&sorted), owned(&["Clap", "peepoHey"]));
    }

    #[test]
    fn the_same_image_under_two_names_stays_two_entries() {
        // A channel aliasing a global emote: same id, both names completable.
        let sorted = sort_and_dedupe(vec![entry("a", "Clap"), entry("a", "clap2")]);
        assert_eq!(names_of(&sorted), owned(&["Clap", "clap2"]));
    }

    #[test]
    fn names_differing_only_in_case_are_kept_apart() {
        // Distinct emotes, so both have to stay completable.
        let sorted = sort_and_dedupe(vec![entry("a", "pepega"), entry("b", "Pepega")]);
        assert_eq!(names_of(&sorted), owned(&["Pepega", "pepega"]));
    }

    #[test]
    fn twitch_entries_get_their_image_url_from_their_id() {
        let converted = EmoteEntry::from_twitch(&kappa());
        assert_eq!(converted.provider, "twitch");
        assert!(
            converted.url.contains("/25/"),
            "built from the id: {}",
            converted.url
        );
    }

    fn channel_tab(id: &str, channel: &str, account: &str) -> Tab {
        Tab {
            id: id.to_string(),
            kind: "channel".to_string(),
            channel: channel.to_string(),
            account: account.to_string(),
            avatar_mode: None,
            mention: None,
        }
    }

    fn account(id: &str, login: &str) -> Account {
        Account {
            id: id.to_string(),
            login: login.to_string(),
            access_token: format!("token-{id}"),
            refresh_token: format!("refresh-{id}"),
            scopes: vec!["chat:read".to_string()],
            avatar_url: String::new(),
        }
    }

    #[test]
    fn cache_keys_cover_every_joined_channel() {
        let state = AppState::new();
        state
            .twitch_global_emotes
            .write()
            .insert(ANONYMOUS.to_string(), vec![kappa()]);
        state.sessions.write().insert(
            (ANONYMOUS.to_string(), "forsen".to_string()),
            Session {
                twitch_emotes: vec![TwitchEmote {
                    id: "99".to_string(),
                    name: "forsenE".to_string(),
                }],
                ..Session::default()
            },
        );

        let keys = state.active_cache_keys();
        assert!(keys.contains("twitch-25"), "globals stay cached");
        assert!(
            keys.contains("twitch-99"),
            "a joined channel's emotes stay cached"
        );
    }

    #[test]
    fn emote_sets_are_not_loaded_until_every_channel_has_landed() {
        let state = AppState::new();
        state
            .global_emotes
            .write()
            .insert("Clap".to_string(), sample_emote());
        state
            .global_emotes_ready
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .tabs
            .write()
            .push(channel_tab("1", "forsen", ANONYMOUS));
        state.tabs.write().push(channel_tab("2", "nymn", ANONYMOUS));
        {
            let mut data = state.data.write();
            data.entry("forsen".to_string()).or_default().assets_ready = true;
            data.entry("nymn".to_string()).or_default();
        }
        assert!(!state.emote_sets_are_loaded(), "nymn is still fetching");

        state
            .data
            .write()
            .entry("nymn".to_string())
            .or_default()
            .assets_ready = true;
        assert!(state.emote_sets_are_loaded());
    }

    /// The same channel open twice is one channel to fetch, not two -- the
    /// sets belong to the room, not to the account reading it.
    #[test]
    fn a_channel_open_under_two_accounts_is_loaded_once() {
        let state = AppState::new();
        state
            .global_emotes
            .write()
            .insert("Clap".to_string(), sample_emote());
        state
            .global_emotes_ready
            .store(true, std::sync::atomic::Ordering::Release);
        state.tabs.write().push(channel_tab("1", "forsen", "111"));
        state.tabs.write().push(channel_tab("2", "forsen", "222"));
        state
            .data
            .write()
            .entry("forsen".to_string())
            .or_default()
            .assets_ready = true;

        assert_eq!(state.open_channels().len(), 1);
        assert!(state.emote_sets_are_loaded());
    }

    #[test]
    fn emote_sets_are_not_loaded_without_the_global_set() {
        let state = AppState::new();
        state
            .tabs
            .write()
            .push(channel_tab("1", "forsen", ANONYMOUS));
        state
            .data
            .write()
            .entry("forsen".to_string())
            .or_default()
            .assets_ready = true;
        assert!(
            !state.emote_sets_are_loaded(),
            "the global set is still fetching"
        );
    }

    #[test]
    fn a_loaded_empty_global_set_is_ready() {
        let state = AppState::new();
        state
            .global_emotes_ready
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(state.emote_sets_are_loaded());
    }

    #[test]
    fn simultaneous_accounts_share_the_same_room_asset_lock() {
        let state = AppState::new();
        let first = state.channel_asset_lock("forsen");
        let second = state.channel_asset_lock("forsen");
        assert!(Arc::ptr_eq(&first, &second));
    }

    /// Only accounts with channel tabs need sockets. Mentions tabs stop
    /// listening when the channel tabs feeding them close.
    #[test]
    fn connections_are_wanted_per_account() {
        let state = AppState::new();
        state.tabs.write().push(channel_tab("1", "forsen", "111"));
        state.tabs.write().push(channel_tab("2", "forsen", "222"));
        state.tabs.write().push(channel_tab("3", "nymn", "111"));
        state.tabs.write().push(Tab {
            id: "4".to_string(),
            kind: "mentions".to_string(),
            channel: String::new(),
            account: "333".to_string(),
            avatar_mode: None,
            mention: None,
        });

        let wanted = state.wanted();
        assert_eq!(wanted.len(), 2);
        assert_eq!(wanted["111"].len(), 2, "both channels on one socket");
        assert_eq!(wanted["222"], HashSet::from(["forsen".to_string()]));
        assert!(
            !wanted.contains_key("333"),
            "a mentions tab keeps no socket alive"
        );
    }

    #[test]
    fn only_known_emotes_are_counted() {
        let state = AppState::new();
        state
            .twitch_global_emotes
            .write()
            .insert(ANONYMOUS.to_string(), vec![kappa()]);
        assert!(state.record_emote_uses(
            ANONYMOUS,
            "forsen",
            &owned(&["Kappa", "definitely not an emote"])
        ));

        let uses = state.emote_uses.read();
        assert_eq!(uses.get("Kappa"), Some(&1));
        assert_eq!(uses.len(), 1, "unknown words never enter the map");
    }

    /// The ranking is shared across accounts, like every other preference --
    /// what you type is what you type, whoever you're typing it as.
    #[test]
    fn repeated_uses_accumulate() {
        let state = AppState::new();
        state
            .twitch_global_emotes
            .write()
            .insert(ANONYMOUS.to_string(), vec![kappa()]);
        state.record_emote_uses(ANONYMOUS, "forsen", &owned(&["Kappa", "Kappa"]));
        state.record_emote_uses(ANONYMOUS, "forsen", &owned(&["Kappa"]));
        assert_eq!(state.emote_uses.read().get("Kappa"), Some(&3));
    }

    #[test]
    fn a_message_with_no_known_emotes_needs_no_save() {
        let state = AppState::new();
        assert!(!state.record_emote_uses(ANONYMOUS, "forsen", &owned(&["hello", "chat"])));
    }

    #[test]
    fn an_explicit_override_wins_over_the_built_in_client_id() {
        // The escape hatch: without this there'd be no way off a suspended or
        // rate-limited Twitch app short of shipping a new release.
        let auth = Auth {
            client_id_override: Some("override-id".to_string()),
            ..Auth::default()
        };
        assert_eq!(auth.client_id(), Some("override-id"));
    }

    #[test]
    fn every_build_ships_with_a_client_id() {
        // build.rs supplies one whenever TWITCH_CLIENT_ID isn't set, so no
        // build can reach a user asking them to go and register a Twitch app.
        assert!(crate::auth::BUILT_IN_CLIENT_ID.is_some());
        assert_eq!(Auth::default().client_id(), crate::auth::BUILT_IN_CLIENT_ID);
    }

    #[test]
    fn credentials_are_per_account_and_anonymous_has_none() {
        let auth = Auth {
            client_id_override: Some("id".to_string()),
            accounts: vec![account("111", "first"), account("222", "second")],
            ..Auth::default()
        };

        let (client_id, token) = auth.credentials("222").expect("both halves present");
        assert_eq!(token, "token-222");
        assert_eq!(Some(client_id.as_str()), auth.client_id());
        assert!(
            auth.credentials(ANONYMOUS).is_none(),
            "anonymous holds no token"
        );
        assert!(
            auth.credentials("nobody").is_none(),
            "an unknown id is not an account"
        );
    }

    /// Asking Twitch who's live, or for a badge image, doesn't care which
    /// login asks -- so those calls keep working while a tab is anonymous.
    #[test]
    fn any_credentials_prefers_the_default_account() {
        let auth = Auth {
            accounts: vec![account("111", "first"), account("222", "second")],
            default_account: "222".to_string(),
            ..Auth::default()
        };
        assert_eq!(
            auth.any_credentials().map(|(_, token)| token),
            Some("token-222".to_string())
        );

        let auth = Auth {
            default_account: ANONYMOUS.to_string(),
            ..auth
        };
        assert_eq!(
            auth.any_credentials().map(|(_, token)| token),
            Some("token-111".to_string()),
            "with no default, the first account answers"
        );
    }

    /// Scopes are granted per token, so one account being allowed to time
    /// people out says nothing about another.
    #[test]
    fn scopes_are_held_per_account() {
        let mut privileged = account("222", "second");
        privileged
            .scopes
            .push("moderator:manage:banned_users".to_string());
        let auth = Auth {
            accounts: vec![account("111", "first"), privileged],
            ..Auth::default()
        };

        assert!(auth.has_scope("222", "moderator:manage:banned_users"));
        assert!(!auth.has_scope("111", "moderator:manage:banned_users"));
        assert!(!auth.has_scope(ANONYMOUS, "chat:read"));
    }
}
