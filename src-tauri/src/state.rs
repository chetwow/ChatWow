//! Shared application state.

use parking_lot::RwLock;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tokio::sync::mpsc;

use crate::emotes::Emote;
use crate::irc::parse::IrcMessage;
use crate::twitch::badges::BadgeMap;
use crate::twitch::emotes::TwitchEmote;

/// Commands sent from Tauri command handlers into the IRC task.
#[derive(Debug, Clone)]
pub enum IrcCommand {
    Join(String),
    Part(String),
    /// Drop and rebuild the connection, e.g. after signing in.
    Reconnect,
}

#[derive(Debug, Clone, Default)]
pub struct Auth {
    /// A Client ID the user deliberately set in the account dialog, replacing
    /// the compiled-in one. Deliberately a different settings key from the old
    /// `client_id`, so a file left by an earlier build can't supply one: an
    /// override only ever exists because someone asked for it in this build.
    pub client_id_override: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub login: Option<String>,
    /// Our own numeric Twitch id, from `/oauth2/validate`. Needed as the
    /// `sender_id` on Helix's chat-messages endpoint.
    pub user_id: Option<String>,
    /// The scopes the token carries, as Twitch reports them. Not what we
    /// asked for: a token predates any later change to `permission_groups`,
    /// and Twitch grants what the user approved on the consent screen.
    pub scopes: Vec<String>,
    /// The optional permission groups the next sign-in will ask for.
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
        self.client_id_override.as_deref().or(crate::auth::BUILT_IN_CLIENT_ID)
    }

    /// Whether the token carries a scope. Answered from the token rather than
    /// from which permission groups are ticked: a group turned on after signing
    /// in isn't granted until the next one.
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|held| held == scope)
    }

    /// Client id + token, present only when we can call Helix.
    pub fn credentials(&self) -> Option<(String, String)> {
        match (self.client_id(), &self.access_token) {
            (Some(id), Some(token)) => Some((id.to_string(), token.clone())),
            _ => None,
        }
    }
}

/// What the UI needs to know about the auth state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_client_id: bool,
    /// The override in force, if any. `None` means the compiled-in Client ID,
    /// which is the normal case.
    pub client_id_override: Option<String>,
    pub logged_in: bool,
    pub login: Option<String>,
    /// What the current token actually allows. Empty when signed out.
    pub scopes: Vec<String>,
    /// The optional permission groups the next sign-in will ask for.
    pub permission_groups: Vec<String>,
    /// The groups themselves -- ids, labels and what each one is for. Static,
    /// but it travels with the status so the account panel has one source for
    /// what to draw and what's been granted.
    pub permission_catalog: &'static [crate::auth::PermissionGroup],
}

/// Per-channel caches. `ready` gates message rendering until emotes land.
#[derive(Debug, Default)]
pub struct ChannelData {
    pub room_id: Option<String>,
    pub ready: bool,
    /// What we are here, from our own USERSTATE. Decides which commands the
    /// picker offers -- there's no Helix endpoint that answers "am I a mod in
    /// this channel", so this tag is the only source.
    pub role: crate::irc::parse::ChannelRole,
    /// Messages received before the emote/badge fetch finished.
    pub pending: Vec<IrcMessage>,
    pub emotes: HashMap<String, Emote>,
    /// Twitch's own emotes for this channel -- completion fodder, deliberately
    /// not part of `emotes` (see `twitch::emotes`).
    pub twitch_emotes: Vec<TwitchEmote>,
    pub badges: BadgeMap,
}

/// Cap the pre-ready buffer so a hung fetch can't eat memory on a busy channel.
pub const MAX_PENDING: usize = 300;

pub struct AppState {
    pub http: reqwest::Client,
    /// The client link previews use. Separate from `http` because it's the one
    /// that goes wherever a chatter pointed it -- see `linkinfo`.
    pub link_http: reqwest::Client,
    pub commands: RwLock<Option<mpsc::UnboundedSender<IrcCommand>>>,
    /// Joined channels, lowercase, in tab order.
    pub channels: RwLock<Vec<String>>,
    pub data: RwLock<HashMap<String, ChannelData>>,
    pub global_emotes: RwLock<HashMap<String, Emote>>,
    /// Twitch's global emotes, same shape as `ChannelData::twitch_emotes`.
    pub twitch_global_emotes: RwLock<Vec<TwitchEmote>>,
    pub global_badges: RwLock<BadgeMap>,
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
    pub auth: RwLock<Auth>,
    /// Logins currently broadcasting, refreshed by the live poller. Empty when
    /// signed out, where we simply don't know rather than knowing they're off.
    pub live: RwLock<HashSet<String>>,
    /// Kicks the live poller off its interval, so a channel you just joined
    /// gets its dot now rather than up to a poll period later.
    pub live_poll: tokio::sync::Notify,
    /// Tells the whisper socket its credentials changed: it drops the
    /// connection and comes back with the new token, or idles here when
    /// there's no longer one to listen with.
    pub eventsub_restart: tokio::sync::Notify,
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
            link_http: crate::linkinfo::build_client(),
            commands: RwLock::new(None),
            channels: RwLock::new(Vec::new()),
            data: RwLock::new(HashMap::new()),
            global_emotes: RwLock::new(HashMap::new()),
            twitch_global_emotes: RwLock::new(Vec::new()),
            global_badges: RwLock::new(BadgeMap::new()),
            seventv_badges: RwLock::new(HashMap::new()),
            seventv_badges_asked: RwLock::new(HashSet::new()),
            badge_lookups: RwLock::new(None),
            emote_uses: RwLock::new(HashMap::new()),
            preferences: RwLock::new(crate::settings::Preferences::default()),
            auth: RwLock::new(Auth::default()),
            live: RwLock::new(HashSet::new()),
            live_poll: tokio::sync::Notify::new(),
            eventsub_restart: tokio::sync::Notify::new(),
        }
    }

    /// Ask 7TV about a chatter's badge, once. Called for every message that
    /// arrives, so the cheap checks come first: the preference, then whether
    /// this chatter has been asked about before.
    pub fn queue_badge_lookup(&self, user_id: &str) {
        if user_id.is_empty() || !self.preferences.read().show_seventv_badges {
            return;
        }
        if !self.seventv_badges_asked.write().insert(user_id.to_string()) {
            return;
        }
        if let Some(tx) = self.badge_lookups.read().as_ref() {
            let _ = tx.send(user_id.to_string());
        }
    }

    pub fn send(&self, command: IrcCommand) {
        if let Some(tx) = self.commands.read().as_ref() {
            let _ = tx.send(command);
        }
    }

    /// Every emote completable in a channel: the 7TV global and channel sets
    /// plus, when signed in, Twitch's global and channel emotes.
    pub fn emote_entries(&self, channel: &str) -> Vec<EmoteEntry> {
        let mut entries: Vec<EmoteEntry> =
            self.global_emotes.read().values().map(EmoteEntry::from_emote).collect();
        entries.extend(self.twitch_global_emotes.read().iter().map(EmoteEntry::from_twitch));
        if let Some(data) = self.data.read().get(channel) {
            entries.extend(data.emotes.values().map(EmoteEntry::from_emote));
            entries.extend(data.twitch_emotes.iter().map(EmoteEntry::from_twitch));
        }
        sort_and_dedupe(entries)
    }

    /// Whether every emote set we expect is in hand: the global 7TV set and
    /// each joined channel's. Only then does "no channel can reach this image"
    /// mean anything -- ask mid-load and every emote belonging to a channel
    /// still fetching looks unreachable. A channel that never loads leaves this
    /// false, which just means stale images linger: the safe way to be wrong.
    pub fn emote_sets_are_loaded(&self) -> bool {
        if self.global_emotes.read().is_empty() {
            return false;
        }
        let channels = self.channels.read();
        let data = self.data.read();
        channels.iter().all(|channel| data.get(channel).is_some_and(|c| c.ready))
    }

    /// Cache keys for every emote image worth keeping on disk: the ones
    /// reachable from any joined channel. Anything else is stale.
    pub fn active_cache_keys(&self) -> HashSet<String> {
        let mut keys: HashSet<String> =
            self.global_emotes.read().values().map(|e| cache_key(e.provider, &e.id)).collect();
        keys.extend(
            self.twitch_global_emotes.read().iter().map(|e| cache_key("twitch", &e.id)),
        );
        for data in self.data.read().values() {
            keys.extend(data.emotes.values().map(|e| cache_key(e.provider, &e.id)));
            keys.extend(data.twitch_emotes.iter().map(|e| cache_key("twitch", &e.id)));
        }
        keys
    }

    /// Count emotes that went out in a message. Names we don't recognize are
    /// ignored, so the persisted map only ever holds real emotes. Returns
    /// whether anything changed, i.e. whether settings need rewriting.
    pub fn record_emote_uses(&self, channel: &str, names: &[String]) -> bool {
        let known: HashSet<String> =
            self.emote_entries(channel).into_iter().map(|entry| entry.name).collect();
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
            logged_in: auth.access_token.is_some(),
            login: auth.login.clone(),
            scopes: auth.scopes.clone(),
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
        TwitchEmote { id: "25".to_string(), name: "Kappa".to_string() }
    }

    #[test]
    fn emote_names_are_ordered_case_insensitively() {
        let sorted = sort_and_dedupe(vec![entry("a", "Zulul"), entry("b", "apu"), entry("c", "Bedge")]);
        assert_eq!(names_of(&sorted), owned(&["apu", "Bedge", "Zulul"]));
    }

    #[test]
    fn an_emote_in_two_sets_is_listed_once() {
        // 7TV channel sets routinely re-add a global emote unchanged.
        let sorted = sort_and_dedupe(vec![entry("a", "Clap"), entry("b", "peepoHey"), entry("a", "Clap")]);
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
        assert!(converted.url.contains("/25/"), "built from the id: {}", converted.url);
    }

    #[test]
    fn cache_keys_cover_every_joined_channel() {
        let state = AppState::new();
        state.twitch_global_emotes.write().push(kappa());
        state.data.write().entry("forsen".to_string()).or_default().twitch_emotes =
            vec![TwitchEmote { id: "99".to_string(), name: "forsenE".to_string() }];

        let keys = state.active_cache_keys();
        assert!(keys.contains("twitch-25"), "globals stay cached");
        assert!(keys.contains("twitch-99"), "a joined channel's emotes stay cached");
    }

    #[test]
    fn emote_sets_are_not_loaded_until_every_channel_has_landed() {
        let state = AppState::new();
        state.global_emotes.write().insert("Clap".to_string(), sample_emote());
        state.channels.write().push("forsen".to_string());
        state.channels.write().push("nymn".to_string());
        {
            let mut data = state.data.write();
            data.entry("forsen".to_string()).or_default().ready = true;
            data.entry("nymn".to_string()).or_default();
        }
        assert!(!state.emote_sets_are_loaded(), "nymn is still fetching");

        state.data.write().entry("nymn".to_string()).or_default().ready = true;
        assert!(state.emote_sets_are_loaded());
    }

    #[test]
    fn emote_sets_are_not_loaded_without_the_global_set() {
        let state = AppState::new();
        state.channels.write().push("forsen".to_string());
        state.data.write().entry("forsen".to_string()).or_default().ready = true;
        assert!(!state.emote_sets_are_loaded(), "the global set is still fetching");
    }

    #[test]
    fn only_known_emotes_are_counted() {
        let state = AppState::new();
        state.twitch_global_emotes.write().push(kappa());
        assert!(state.record_emote_uses("forsen", &owned(&["Kappa", "definitely not an emote"])));

        let uses = state.emote_uses.read();
        assert_eq!(uses.get("Kappa"), Some(&1));
        assert_eq!(uses.len(), 1, "unknown words never enter the map");
    }

    #[test]
    fn repeated_uses_accumulate() {
        let state = AppState::new();
        state.twitch_global_emotes.write().push(kappa());
        state.record_emote_uses("forsen", &owned(&["Kappa", "Kappa"]));
        state.record_emote_uses("forsen", &owned(&["Kappa"]));
        assert_eq!(state.emote_uses.read().get("Kappa"), Some(&3));
    }

    #[test]
    fn a_message_with_no_known_emotes_needs_no_save() {
        let state = AppState::new();
        assert!(!state.record_emote_uses("forsen", &owned(&["hello", "chat"])));
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
    fn credentials_need_both_an_id_and_a_token() {
        let mut auth = Auth {
            client_id_override: Some("id".to_string()),
            ..Auth::default()
        };
        assert!(auth.credentials().is_none(), "no token yet");

        auth.access_token = Some("token".to_string());
        let (client_id, token) = auth.credentials().expect("both halves present");
        assert_eq!(token, "token");
        assert_eq!(Some(client_id.as_str()), auth.client_id());
    }
}

