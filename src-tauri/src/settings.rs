//! Small JSON settings file in the app config dir.
//!
//! Holds the Twitch Client ID, every signed-in account's tokens, the open tabs
//! and the user's preferences so the app comes back up where you left it.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One signed-in Twitch account.
///
/// The tokens never leave Rust: what crosses to the frontend is
/// `state::AccountInfo`, which is this without them. Scopes are per account and
/// not negotiable after the fact -- Twitch grants them once on the consent
/// screen -- so two accounts can perfectly well differ in what they may do.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    /// Twitch's numeric user id. The account's identity everywhere: it
    /// survives a name change, where a login doesn't, and it's what a tab
    /// points at.
    pub id: String,
    pub login: String,
    pub access_token: String,
    pub refresh_token: String,
    /// What `/oauth2/validate` last said this token carries.
    pub scopes: Vec<String>,
    /// The account's Twitch profile picture, for the accounts list. Stored
    /// rather than fetched when the panel opens, so the rows draw with the
    /// settings file rather than after a round trip -- `check_token` refreshes
    /// it on the same pass that refreshes the login, and it's empty both for an
    /// account signed in by an earlier build and whenever Twitch didn't answer.
    #[serde(default)]
    pub avatar_url: String,
}

/// The id of the account a tab reads as, or `ANONYMOUS` for none.
///
/// Anonymous is a real choice rather than a broken state: Twitch serves chat to
/// a `justinfan` login without any token, which is how this app works before
/// you ever sign in, and it stays available per tab afterwards.
pub const ANONYMOUS: &str = "";

/// One tab: a channel read as some account, or the mentions collected for one.
///
/// Tabs are the unit the app is built around now, not channels -- the same
/// channel can be open twice under two accounts, so the channel name no longer
/// identifies a view. `id` does, and everything the frontend keeps per view
/// (messages, unread, scroll) is keyed by it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    /// Unique and stable for the life of the tab. Minted by the frontend when
    /// it opens one, so the view it just created has a key immediately rather
    /// than after a round trip.
    pub id: String,
    /// `channel` or `mentions`.
    pub kind: String,
    /// Empty for a mentions tab, which belongs to an account rather than a room.
    pub channel: String,
    /// Which account this tab reads (and sends) as. `ANONYMOUS` for none.
    pub account: String,
    /// Which picture this tab draws behind its name: `none`, `owner` (the
    /// channel's) or `account` (the one it reads as). The tab's own answer,
    /// not a preference read at render time -- `new_tab_avatar_mode` decides
    /// only what a *new* tab is stamped with, and a tab keeps what it was
    /// given until its right-click menu says otherwise. `None` is a tab from
    /// a build before this existed, stamped on the next load. Not validated
    /// here -- see the note on `chat_font_size`.
    #[serde(default)]
    pub avatar_mode: Option<String>,
}

impl Tab {
    pub fn is_channel(&self) -> bool {
        self.kind == "channel" && !self.channel.is_empty()
    }
}

/// One blacklist entry: either an emote *name* (which catches every emote
/// going by that name, in any channel) or a `<provider>-<id>` image key (which
/// catches one specific image however it's been aliased). Same shape for both
/// lists, so the settings dialog edits them with one control.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmoteRule {
    /// `name` or `id`. Not validated here -- see `Preferences`.
    pub kind: String,
    pub value: String,
}

/// What the settings dialog edits. Serialized camelCase because this struct
/// crosses to the frontend as-is (see the `Preferences` type in `types.ts`);
/// the fields around it predate that and stay snake_case in the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    /// Size preset for chat text: `small`, `medium`, `large` or `larger`.
    /// A value the frontend doesn't know falls back to `medium` there rather
    /// than being rejected here, so a hand-edited file can't wedge the UI.
    pub chat_font_size: String,
    /// Ping when someone writes `@you`.
    pub notify_on_tag: bool,
    /// Ping when someone uses your name without the `@`.
    pub notify_on_name: bool,
    /// Ping for mentions in the channel you're currently reading. Off by
    /// default -- you can see that tab, so the sound is just noise.
    pub notify_active_tab: bool,
    /// Load a channel's recent messages when you join it. On by default: an
    /// empty pane tells you nothing about a channel you've just opened. It's
    /// the one thing that talks to a third party, which is why it's a setting
    /// -- see `irc::history`.
    pub show_message_history: bool,
    /// Third-party emote providers, each on by default. Off means we never
    /// ask that service for anything -- the emotes simply aren't there, and
    /// the ones already on screen fall back to the text that was typed.
    pub enable_seventv: bool,
    pub enable_bttv: bool,
    pub enable_ffz: bool,
    /// Show the 7TV badge a chatter has equipped, beside their Twitch ones.
    /// Off means 7TV is never asked who anybody is.
    pub show_seventv_badges: bool,
    /// Draw `/me` actions in italics, the way Twitch does. Off leaves them in
    /// the sender's color but upright.
    pub italic_actions: bool,
    /// Show the time beside each message.
    pub show_timestamps: bool,
    /// Show the sending account's picture beside the message box. On by
    /// default -- with two accounts signed in it's the only thing that keeps
    /// saying which one a tab speaks as once the placeholder is typed over.
    pub show_composer_avatar: bool,
    /// What a newly opened tab is stamped with for the picture behind its
    /// name: `none`, `owner` (the channel's), `account` (the one it reads as)
    /// or `otherAccount` -- that, but only when the new tab isn't on the
    /// default account, which resolves to one of the other two the moment a
    /// tab is made. Only new tabs: changing this leaves the open ones alone,
    /// each of which carries its own `Tab::avatar_mode`.
    pub new_tab_avatar_mode: String,
    /// How strongly that picture is drawn, 0 to 1. A setting because the right
    /// answer depends on the avatar: a dark one at the default is nearly
    /// invisible where a bright one is plenty. Clamped in the frontend, which
    /// is also what draws it.
    pub tab_avatar_opacity: f64,
    /// Show the picture on hover when a link points straight at an image.
    /// On by default, but a setting because it's fetched from whatever host a
    /// chatter linked -- hovering tells that host you're here, which nothing
    /// else about reading chat does.
    pub preview_images: bool,
    /// A YouTube video, which shows the channel, duration, date and counts.
    /// Its own switch because it's the most expensive preview there is: the
    /// page is read to a megabyte to reach numbers Google buries behind
    /// half of it (see `linkinfo`).
    pub preview_youtube: bool,
    /// A Twitch clip, VOD or channel, which comes from Helix rather than the
    /// page (see `twitch::links`). Its own switch because it's the one that
    /// goes to Twitch with your token rather than to a stranger's host.
    pub preview_twitch: bool,
    /// Every other link, which shows what the page says about itself.
    /// Separate from the three above because they cost different things: an
    /// image is one request to the host in the link, where a page is a
    /// request, a read, and a thumbnail from wherever that page names.
    pub preview_pages: bool,
    /// Keep the channel tabs on one row and scroll them sideways. On by
    /// default: wrapping keeps every tab in sight, but it also lets the tab
    /// bar grow to several rows deep and take that height off the chat.
    pub single_row_tabs: bool,
    /// Whether the window is split, and along which axis: `none`, `row`
    /// (panes side by side) or `column` (stacked). A value this app doesn't
    /// know falls back to `none` in the frontend, like `chat_font_size`.
    pub split_layout: String,
    /// How much of the split axis the first pane gets, as a fraction. The
    /// frontend clamps it so neither pane can be dragged away to nothing.
    pub split_ratio: f64,
    /// How many of the leading `tabs` belong to the first pane; the rest
    /// belong to the second. One number rather than two lists, so `tabs`
    /// stays the single record of which tabs exist and in what order --
    /// dragging a tab across the divider is a move within that one list.
    pub split_index: usize,
    /// Mentions to say nothing about, each entry either `@login` or
    /// `#channel`. One list rather than two: they're the same instruction
    /// ("don't tell me about this") and the prefix is what it applies to.
    /// Not validated here -- see the note on `chat_font_size`.
    pub mention_ignores: Vec<String>,
    /// Logins whose messages aren't drawn at all. Matched at render time in
    /// the frontend, so unblocking brings the backlog back.
    pub blocked_users: Vec<String>,
    /// The title bar's quick mute. Silences the ping without touching the two
    /// toggles above, so unmuting restores exactly what you had.
    pub muted: bool,
    /// Emotes drawn as their underlined name instead of their image.
    pub emote_blacklist: Vec<EmoteRule>,
    /// Emotes kept out of Tab completion and the `:` picker. Independent of
    /// the list above -- hiding an image and hiding a suggestion are separate
    /// annoyances.
    pub emote_complete_blacklist: Vec<EmoteRule>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            chat_font_size: "medium".to_string(),
            notify_on_tag: true,
            notify_on_name: true,
            notify_active_tab: false,
            show_message_history: true,
            enable_seventv: true,
            enable_bttv: true,
            enable_ffz: true,
            show_seventv_badges: true,
            italic_actions: true,
            show_timestamps: true,
            show_composer_avatar: true,
            new_tab_avatar_mode: "owner".to_string(),
            tab_avatar_opacity: 0.4,
            preview_images: true,
            preview_youtube: true,
            preview_twitch: true,
            preview_pages: true,
            single_row_tabs: true,
            split_layout: "none".to_string(),
            split_ratio: 0.5,
            split_index: 0,
            mention_ignores: Vec::new(),
            blocked_users: Vec::new(),
            muted: false,
            emote_blacklist: Vec::new(),
            emote_complete_blacklist: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// See `state::Auth::client_id_override` for why this isn't `client_id`.
    pub client_id_override: Option<String>,
    /// Every signed-in account, in the order the settings dialog lists them.
    pub accounts: Vec<Account>,
    /// Which account a newly opened tab reads as. Empty means anonymous, which
    /// is also what an id no account answers to falls back to.
    pub default_account: String,
    /// The open tabs, in bar order. Supersedes `channels`, which is read once
    /// on the way past to migrate a file written before accounts existed.
    pub tabs: Vec<Tab>,
    /// Which optional `auth::PermissionGroup`s the next sign-in asks for, on
    /// top of the required ones. Empty by default: the moderator and
    /// broadcaster commands are off until someone asks for them.
    pub permission_groups: Vec<String>,
    /// A single account's session, as written before this app could hold more
    /// than one. Read by `migrate`, never written again -- these keys leave the
    /// file the first time it's saved.
    #[serde(skip_serializing)]
    pub access_token: Option<String>,
    #[serde(skip_serializing)]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing)]
    pub login: Option<String>,
    #[serde(skip_serializing)]
    pub user_id: Option<String>,
    #[serde(skip_serializing)]
    pub scopes: Vec<String>,
    /// The channel list as written before tabs existed. Same story.
    #[serde(skip_serializing)]
    pub channels: Vec<String>,
    /// How often each emote name has been sent, used to rank completions.
    pub emote_uses: HashMap<String, u32>,
    pub preferences: Preferences,
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// Bring a file written by an earlier build up to the current shape.
///
/// Two things moved: one account's tokens became a list, and the channel list
/// became a list of tabs. Both are read from the keys they used to live under,
/// which are `skip_serializing` -- so they survive exactly long enough to be
/// migrated and leave the file on the next save.
fn migrate(settings: &mut Settings, raw: &str) {
    if settings.accounts.is_empty() {
        if let (Some(id), Some(login), Some(access), Some(refresh)) = (
            settings.user_id.clone(),
            settings.login.clone(),
            settings.access_token.clone(),
            settings.refresh_token.clone(),
        ) {
            settings.accounts.push(Account {
                id: id.clone(),
                login,
                access_token: access,
                refresh_token: refresh,
                scopes: std::mem::take(&mut settings.scopes),
                // Nothing to migrate from: the first token check fills it in.
                avatar_url: String::new(),
            });
            settings.default_account = id;
        }
    }

    if !settings.tabs.is_empty() || settings.channels.is_empty() {
        return;
    }

    let account = settings.default_account.clone();
    settings.tabs = settings
        .channels
        .iter()
        .map(|channel| Tab {
            id: format!("tab-{channel}"),
            kind: "channel".to_string(),
            channel: channel.clone(),
            account: account.clone(),
            avatar_mode: None,
        })
        .collect();

    // The mentions tab was a preference rather than a tab, and where it sat was
    // two more. It's an ordinary tab now, so it's placed once, here, and the
    // pane boundary moves with it -- reading those three keys straight out of
    // the JSON keeps them from having to live on in `Preferences`.
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else { return };
    let old = &value["preferences"];
    if old["mentionsTab"].as_bool() != Some(true) {
        return;
    }
    let pane = old["mentionsPane"].as_u64().unwrap_or(0) as usize;
    let within = old["mentionsTabIndex"].as_u64().unwrap_or(0) as usize;
    let split = settings.preferences.split_index.min(settings.tabs.len());
    let at = match pane {
        0 => within.min(split),
        _ => split + within.min(settings.tabs.len() - split),
    };
    settings.tabs.insert(
        at,
        Tab {
            id: "tab-mentions".to_string(),
            kind: "mentions".to_string(),
            channel: String::new(),
            account,
            avatar_mode: None,
        },
    );
    if at <= split {
        settings.preferences.split_index = split + 1;
    }
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(file) = path(app) else { return Settings::default() };
    let Ok(raw) = std::fs::read_to_string(file) else { return Settings::default() };
    let mut settings: Settings = serde_json::from_str(&raw).unwrap_or_default();
    migrate(&mut settings, &raw);
    settings
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let file = path(app)?;
    std::fs::write(file, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file from before accounts existed comes back as one account and a tab
    /// per channel, rather than as a signed-out app with nothing open.
    #[test]
    fn a_single_account_file_migrates_to_accounts_and_tabs() {
        let raw = r#"{
            "access_token": "at", "refresh_token": "rt", "login": "someone",
            "user_id": "12345", "scopes": ["chat:read"],
            "channels": ["forsen", "xqc"]
        }"#;
        let mut settings: Settings = serde_json::from_str(raw).unwrap();
        migrate(&mut settings, raw);

        assert_eq!(settings.accounts.len(), 1);
        assert_eq!(settings.accounts[0].id, "12345");
        assert_eq!(settings.accounts[0].login, "someone");
        assert_eq!(settings.accounts[0].scopes, vec!["chat:read".to_string()]);
        assert_eq!(settings.default_account, "12345");

        let tabs: Vec<&str> = settings.tabs.iter().map(|t| t.channel.as_str()).collect();
        assert_eq!(tabs, vec!["forsen", "xqc"]);
        assert!(settings.tabs.iter().all(|tab| tab.account == "12345"));
    }

    /// The mentions tab was three preferences; it becomes a tab, in the place
    /// those three described -- including on the far side of a split.
    #[test]
    fn the_mentions_preference_becomes_a_tab_where_it_sat() {
        let raw = r#"{
            "channels": ["a", "b", "c"],
            "preferences": {
                "mentionsTab": true, "mentionsTabIndex": 1, "mentionsPane": 1,
                "splitLayout": "row", "splitIndex": 2
            }
        }"#;
        let mut settings: Settings = serde_json::from_str(raw).unwrap();
        migrate(&mut settings, raw);

        let kinds: Vec<&str> = settings.tabs.iter().map(|t| t.kind.as_str()).collect();
        assert_eq!(kinds, vec!["channel", "channel", "channel", "mentions"]);
        // Second pane, one tab in: after "c", which is that pane's first tab.
        assert_eq!(settings.tabs[3].kind, "mentions");
        // Nothing was added to the first pane, so its boundary doesn't move.
        assert_eq!(settings.preferences.split_index, 2);
    }

    /// Migration is for files that predate tabs. One that already has them is
    /// left exactly as it is, however many accounts it names.
    #[test]
    fn a_file_that_already_has_tabs_is_left_alone() {
        let raw = r#"{
            "accounts": [{"id":"1","login":"a","access_token":"x","refresh_token":"y","scopes":[]}],
            "tabs": [{"id":"t1","kind":"channel","channel":"forsen","account":"1"}],
            "channels": ["nope"]
        }"#;
        let mut settings: Settings = serde_json::from_str(raw).unwrap();
        migrate(&mut settings, raw);

        assert_eq!(settings.tabs.len(), 1);
        assert_eq!(settings.tabs[0].channel, "forsen");
        assert_eq!(settings.accounts.len(), 1);
    }
}
