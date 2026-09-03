//! Replacing the app with a newer one.
//!
//! The whole mechanism is a signed static file: the release workflow writes a
//! `latest.json` onto the GitHub release listing every platform's installer and
//! its minisign signature, and `tauri-plugin-updater` reads it, compares
//! versions, downloads, checks the signature against the public key compiled in
//! from `tauri.conf.json`, and swaps the app. There is no server here to run
//! and nothing to keep up.
//!
//! It lives in Rust rather than behind the plugin's JS API for the reason the
//! rest of the app does -- Rust owns what talks to the network -- and for one
//! more: `updater:default` would give the webview permission to download and
//! execute code, and this app renders arbitrary chat with `csp: null`. Keeping
//! the capability ungranted costs nothing, since the frontend only ever needs
//! to see a state and press a button.
//!
//! Two shapes to know about:
//!
//! * The snapshot in `AppState::update` and the `update://state` event carry
//!   the same value, always written together. Events alone aren't enough --
//!   the settings dialog can be opened halfway through a download and has to
//!   find the picture the events have already painted.
//! * On Windows there is no `Ready` state. `Update::install` hands the
//!   installer to `ShellExecuteW` and exits the process; NSIS puts the app back
//!   up. macOS and Linux swap the files in place and wait to be restarted.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::AppState;

/// Where to look for `latest.json`. Overriding it is how a release is
/// rehearsed against a pre-release before the real one is published -- see
/// ARCHITECTURE.md. Safe to leave in a shipped build: the public key is
/// compiled in, so pointing this somewhere else still can't install anything
/// that wasn't signed with the private key.
const ENDPOINT_ENV: &str = "CHATWOW_UPDATE_ENDPOINT";

/// How long to wait after launch before asking. Long enough that the check
/// isn't competing with the IRC connect and the emote fetches for the first
/// paint, short enough that it has answered by the time anyone opens settings.
const LAUNCH_DELAY_SECS: u64 = 5;

/// What the frontend renders. One struct for every stage, because the dialog
/// re-reads the whole thing on mount and the alternative is two sources of
/// truth that can disagree about whether a download is running.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// `idle`, `checking`, `upToDate`, `available`, `downloading`, `ready` or
    /// `failed`. A string rather than an enum with a payload: it crosses to
    /// TypeScript as-is, and a flat discriminant is what the UI switches on.
    pub stage: String,
    /// This build. Always present -- it's the only place the frontend learns
    /// what version it is, since nothing else tells it.
    pub current_version: String,
    /// The newer version, once one is known.
    pub version: Option<String>,
    /// The release notes, as GitHub put them in `latest.json`.
    pub notes: Option<String>,
    pub downloaded: u64,
    /// `None` when the server sent no `Content-Length`, which is why the UI
    /// has to be able to show a download with no percentage.
    pub total: Option<u64>,
    /// One short line for the user. The detail goes to the log.
    pub error: Option<String>,
    /// Whether this build is one that can replace itself. False on macOS until
    /// the app is signed, where the update is real but applying it would break
    /// the install -- see `can_install`.
    pub can_install: bool,
}

impl UpdateState {
    fn new(current_version: String) -> Self {
        Self {
            stage: "idle".to_string(),
            current_version,
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            error: None,
            can_install: can_install(),
        }
    }

    /// Back to a resting stage, keeping the version we're on and dropping
    /// everything that belonged to the last attempt.
    fn reset(&self, stage: &str) -> Self {
        Self {
            stage: stage.to_string(),
            current_version: self.current_version.clone(),
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            error: None,
            can_install: can_install(),
        }
    }
}

/// Holds the snapshot and the pending download.
pub struct Updates {
    pub state: parking_lot::RwLock<UpdateState>,
    /// The `Update` a check handed back, waiting for someone to press install.
    /// A `tokio` mutex rather than a `parking_lot` one because it's held
    /// across the download's awaits.
    pub pending: tokio::sync::Mutex<Option<Update>>,
}

impl Updates {
    pub fn new(current_version: String) -> Self {
        Self {
            state: parking_lot::RwLock::new(UpdateState::new(current_version)),
            pending: tokio::sync::Mutex::new(None),
        }
    }
}

/// Whether this build can put an update in place itself.
///
/// Only macOS can't, and only until the app is signed. Replacing an *unsigned*
/// bundle in place is what produces "ChatWow is damaged and can't be opened" on
/// the next launch -- a worse thing to hand somebody than no update at all.
/// Nothing in the plugin is at fault and nothing here can work around it: the
/// fix is a Developer ID Application certificate and notarization, at which
/// point this arm comes out and nothing else changes. Tauri's own docs say
/// ad-hoc signing (`signingIdentity: "-"`) isn't enough.
///
/// Every other format is fine, `.deb` and `.rpm` included -- the bundler stamps
/// each binary with the format it was packaged as, so an installed copy asks
/// `latest.json` for its own (`linux-x86_64-deb` and friends are all there) and
/// the plugin hands it to `dpkg -i` behind a graphical root prompt. Nothing
/// here has to tell those apart.
///
/// The check still runs where this is false: knowing a new version exists is
/// useful even when the button can't be what fetches it, so it opens the
/// releases page instead.
fn can_install() -> bool {
    !cfg!(target_os = "macos")
}

/// Store a state and tell the frontend, in that order and never separately.
fn set(app: &AppHandle, shared: &AppState, state: UpdateState) {
    *shared.updates.state.write() = state.clone();
    if let Err(error) = app.emit("update://state", state) {
        log::warn!("couldn't emit update state: {error}");
    }
}

pub fn snapshot(shared: &AppState) -> UpdateState {
    shared.updates.state.read().clone()
}

/// Ask the release for a newer version.
///
/// Failure here is ordinary -- being offline is the common case -- so it
/// resolves to a `failed` state rather than an error the caller has to
/// decide what to do with.
pub async fn check(app: AppHandle, shared: Arc<AppState>) -> UpdateState {
    {
        let resting = shared.updates.state.read().reset("checking");
        set(&app, &shared, resting);
    }

    let updater = match build(&app) {
        Ok(updater) => updater,
        Err(error) => return fail(&app, &shared, "Couldn't check", error),
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let mut state = shared.updates.state.read().reset("available");
            state.version = Some(update.version.clone());
            // Empty notes are the same as none as far as the UI goes, and
            // GitHub happily produces them.
            state.notes = update.body.clone().filter(|body| !body.trim().is_empty());
            *shared.updates.pending.lock().await = Some(update);
            set(&app, &shared, state.clone());
            state
        }
        Ok(None) => {
            *shared.updates.pending.lock().await = None;
            let state = shared.updates.state.read().reset("upToDate");
            set(&app, &shared, state.clone());
            state
        }
        Err(error) => fail(&app, &shared, "Couldn't check", error.to_string()),
    }
}

/// Download the pending update and put it in place.
///
/// On Windows this never returns: the installer is launched and the process
/// exits underneath us.
pub async fn install(app: AppHandle, shared: Arc<AppState>) -> Result<(), String> {
    if !can_install() {
        return Err("This build can't replace itself".to_string());
    }
    let update = match shared.updates.pending.lock().await.take() {
        Some(update) => update,
        None => return Err("There's no update waiting".to_string()),
    };

    {
        let mut state = shared.updates.state.read().clone();
        state.stage = "downloading".to_string();
        state.downloaded = 0;
        state.total = None;
        state.error = None;
        set(&app, &shared, state);
    }

    let progress_app = app.clone();
    let progress_shared = Arc::clone(&shared);
    let finish_app = app.clone();
    let finish_shared = Arc::clone(&shared);

    let outcome = update
        .download_and_install(
            move |chunk, total| {
                let mut state = progress_shared.updates.state.read().clone();
                state.downloaded += chunk as u64;
                state.total = total;
                set(&progress_app, &progress_shared, state);
            },
            move || {
                // Windows is already gone by the time anything after this
                // would run, so this is the last word on the other two.
                let mut state = finish_shared.updates.state.read().clone();
                state.stage = "ready".to_string();
                set(&finish_app, &finish_shared, state);
            },
        )
        .await;

    if let Err(error) = outcome {
        fail(&app, &shared, "Couldn't install", error.to_string());
        return Err("Couldn't install the update".to_string());
    }
    Ok(())
}

/// The check that runs on its own after launch. Never downloads: it only gets
/// as far as saying one is available, and waits to be asked for the rest.
pub async fn check_at_launch(app: AppHandle, shared: Arc<AppState>) {
    tokio::time::sleep(std::time::Duration::from_secs(LAUNCH_DELAY_SECS)).await;
    let state = check(app, shared).await;
    match state.stage.as_str() {
        "available" => log::info!(
            "update available: {}",
            state.version.as_deref().unwrap_or("?")
        ),
        "upToDate" => log::debug!("up to date"),
        _ => {}
    }
}

/// Build an updater, pointing it at the override if one is set.
fn build(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Ok(url) = std::env::var(ENDPOINT_ENV) {
        let parsed = url
            .parse()
            .map_err(|error| format!("{ENDPOINT_ENV} isn't a url: {error}"))?;
        log::info!("update endpoint overridden: {url}");
        builder = builder
            .endpoints(vec![parsed])
            .map_err(|error| error.to_string())?;
    }
    builder.build().map_err(|error| error.to_string())
}

/// Log the real reason, show the user a short one.
fn fail(app: &AppHandle, shared: &AppState, message: &str, detail: String) -> UpdateState {
    log::warn!("{message}: {detail}");
    let mut state = shared.updates.state.read().reset("failed");
    state.error = Some(message.to_string());
    set(app, shared, state.clone());
    state
}
