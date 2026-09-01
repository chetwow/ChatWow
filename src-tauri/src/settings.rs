//! Small JSON settings file in the app config dir.
//!
//! Holds the Twitch Client ID, OAuth tokens, the channel list and the user's
//! preferences so the app comes back up where you left it.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
    /// Keep a tab collecting every mention, reply and whisper from all
    /// channels at once. Off by default: it's a tab you ask for, not one you
    /// find yourself with. Nothing else here changes with it -- the log is
    /// kept either way, so opening the tab isn't opening an empty one.
    pub mentions_tab: bool,
    /// Where that tab sits among the channel tabs. It's an ordinary tab, so
    /// it can be dragged anywhere in the row; an index past the end lands it
    /// last rather than being an error.
    pub mentions_tab_index: usize,
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
            preview_images: true,
            preview_youtube: true,
            preview_twitch: true,
            preview_pages: true,
            single_row_tabs: true,
            mentions_tab: false,
            mentions_tab_index: 0,
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
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub login: Option<String>,
    pub user_id: Option<String>,
    /// The scopes the stored token actually carries, as `/oauth2/validate`
    /// last reported them. Kept so the command picker knows what you can run
    /// from the first frame, rather than after that call comes back.
    pub scopes: Vec<String>,
    /// Which optional `auth::PermissionGroup`s the next sign-in asks for, on
    /// top of the required ones. Empty by default: the moderator and
    /// broadcaster commands are off until someone asks for them.
    pub permission_groups: Vec<String>,
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

pub fn load(app: &AppHandle) -> Settings {
    let Ok(file) = path(app) else { return Settings::default() };
    let Ok(raw) = std::fs::read_to_string(file) else { return Settings::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let file = path(app)?;
    std::fs::write(file, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}
