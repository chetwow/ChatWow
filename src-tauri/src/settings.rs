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
    /// Keep the channel tabs on one row and scroll them sideways, instead of
    /// wrapping onto as many rows as they need.
    pub single_row_tabs: bool,
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
            single_row_tabs: false,
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
