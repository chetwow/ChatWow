mod auth;
mod color;
mod emotes;
mod irc;
#[cfg(test)]
mod livecheck;
mod render;
mod settings;
mod state;
mod twitch;
mod usercard;

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::irc::client;
use crate::state::{AppState, AuthStatus, IrcCommand};
use crate::twitch::chat;

type Shared = Arc<AppState>;

/// Normalize user input into a Twitch channel login.
fn normalize_channel(input: &str) -> Result<String, String> {
    let name = input.trim().trim_start_matches(['#', '@']).to_ascii_lowercase();
    let valid = name.len() >= 3
        && name.len() <= 25
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid {
        Ok(name)
    } else {
        Err(format!("\"{input}\" is not a valid Twitch channel name"))
    }
}

/// Twitch's own limit on message length.
const MAX_MESSAGE_CHARS: usize = 500;

/// Validate outgoing chat text and split out a `/me` action.
/// Returns (is_action, text shown locally, text sent over the wire).
fn prepare_outgoing(text: &str) -> Result<(bool, String, String), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Message is empty".to_string());
    }

    // Strip control characters that could otherwise smuggle extra IRC lines.
    let clean: String = trimmed.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    if clean.chars().count() > MAX_MESSAGE_CHARS {
        return Err("Message is too long".to_string());
    }

    // `clean` never ends in whitespace (trimmed above), so a "/me " prefix
    // match always leaves a non-empty body -- "/me" alone falls through as
    // literal text instead of an empty action.
    match clean.strip_prefix("/me ") {
        Some(rest) => {
            let body = rest.to_string();
            let wire = format!("\u{1}ACTION {body}\u{1}");
            Ok((true, body, wire))
        }
        None => Ok((false, clean.clone(), clean)),
    }
}

fn persist(app: &AppHandle, state: &AppState) {
    let auth = state.auth.read();
    let settings = settings::Settings {
        client_id_override: auth.client_id_override.clone(),
        access_token: auth.access_token.clone(),
        refresh_token: auth.refresh_token.clone(),
        login: auth.login.clone(),
        user_id: auth.user_id.clone(),
        scopes: auth.scopes.clone(),
        permission_groups: auth.permission_groups.clone(),
        channels: state.channels.read().clone(),
        emote_uses: state.emote_uses.read().clone(),
        preferences: state.preferences.read().clone(),
    };
    drop(auth);
    if let Err(error) = settings::save(app, &settings) {
        eprintln!("failed to save settings: {error}");
    }
}

/// Check a stored token on startup, refreshing it if it has expired, then load
/// global assets. A token that can't be recovered is cleared so the UI can
/// prompt for a fresh sign-in instead of silently losing badges.
async fn restore_session(app: AppHandle, state: Shared) {
    let (client_id, access_token, refresh_token) = {
        let auth_state = state.auth.read();
        (
            auth_state.client_id().map(str::to_string),
            auth_state.access_token.clone(),
            auth_state.refresh_token.clone(),
        )
    };

    if let (Some(client_id), Some(token)) = (client_id, access_token) {
        match auth::validate(&state.http, &token).await {
            Ok(validation) => {
                {
                    let mut auth_state = state.auth.write();
                    auth_state.login = Some(validation.login);
                    auth_state.user_id = Some(validation.user_id);
                    // Twitch is the authority on what the token allows, and
                    // what it allows decides which commands the picker offers.
                    auth_state.scopes = validation.scopes;
                }
                persist(&app, &state);
                let _ = app.emit("chat://auth", state.auth_status());
            }
            Err(_) => {
                let refreshed = match refresh_token {
                    Some(token) => auth::refresh(&state.http, &client_id, &token).await.ok(),
                    None => None,
                };

                match refreshed {
                    Some(tokens) => {
                        let validation =
                            auth::validate(&state.http, &tokens.access_token).await.ok();
                        let mut auth_state = state.auth.write();
                        auth_state.access_token = Some(tokens.access_token);
                        if !tokens.refresh_token.is_empty() {
                            auth_state.refresh_token = Some(tokens.refresh_token);
                        }
                        auth_state.login = validation.as_ref().map(|v| v.login.clone());
                        auth_state.scopes =
                            validation.as_ref().map(|v| v.scopes.clone()).unwrap_or_default();
                        auth_state.user_id = validation.map(|v| v.user_id);
                    }
                    None => {
                        let mut auth_state = state.auth.write();
                        auth_state.access_token = None;
                        auth_state.refresh_token = None;
                        auth_state.login = None;
                        auth_state.user_id = None;
                        auth_state.scopes.clear();
                    }
                }

                persist(&app, &state);
                let _ = app.emit("chat://auth", state.auth_status());
                state.send(IrcCommand::Reconnect);
                state.eventsub_restart.notify_one();
            }
        }
    }

    client::load_global_assets(app, state).await;
}

#[tauri::command]
fn auth_status(state: State<'_, Shared>) -> AuthStatus {
    state.auth_status()
}

#[tauri::command]
fn preferences(state: State<'_, Shared>) -> settings::Preferences {
    state.preferences.read().clone()
}

/// Replace the stored preferences wholesale -- the dialog always sends the
/// full set, so there's nothing to merge, and writing the file here means a
/// toggle is durable the moment it's flipped.
#[tauri::command]
fn set_preferences(
    app: AppHandle,
    state: State<'_, Shared>,
    preferences: settings::Preferences,
) -> settings::Preferences {
    let before = emotes::Providers::from(&*state.preferences.read());
    let after = emotes::Providers::from(&preferences);
    let badges_before = state.preferences.read().show_seventv_badges;
    *state.preferences.write() = preferences;
    persist(&app, &state);

    // Switching a provider on has to go and fetch it -- nothing else will, the
    // sets being loaded on join. Switching one off goes through the same path,
    // which is what drops its emotes from completion.
    if before != after {
        let shared = Arc::clone(&state);
        let handle = app.clone();
        tauri::async_runtime::spawn(client::reload_emotes(handle, shared));
    }

    // Badges are resolved as people talk, and everyone already asked about is
    // remembered -- so switching them back on has to forget that, or nobody
    // would be looked up again. What the frontend already holds stays put, so
    // familiar faces keep theirs immediately.
    if !badges_before && state.preferences.read().show_seventv_badges {
        state.seventv_badges_asked.write().clear();
    }

    state.preferences.read().clone()
}

/// Drop the signed-in session and everything that came with it. Badges are
/// the visible half: they're fetched with the token, so they'd otherwise linger
/// as art we can no longer refresh.
fn clear_session(state: &AppState) {
    {
        let mut auth_state = state.auth.write();
        auth_state.access_token = None;
        auth_state.refresh_token = None;
        auth_state.login = None;
        auth_state.user_id = None;
        auth_state.scopes.clear();
    }
    state.global_badges.write().clear();
    for data in state.data.write().values_mut() {
        data.badges.clear();
    }
}

/// Point the app at a different Twitch app, or pass an empty string to go back
/// to the compiled-in one.
///
/// This signs you out: Twitch issues a token against one specific Client ID, so
/// the one we're holding is worthless against the new app. Leaving it in place
/// would look like a broken session rather than a signed-out one.
#[tauri::command]
fn set_client_id_override(
    app: AppHandle,
    state: State<'_, Shared>,
    client_id: String,
) -> AuthStatus {
    let trimmed = client_id.trim().to_string();
    let next = if trimmed.is_empty() { None } else { Some(trimmed) };

    if next == state.auth.read().client_id_override {
        return state.auth_status();
    }

    clear_session(&state);
    state.eventsub_restart.notify_one();
    state.auth.write().client_id_override = next;
    persist(&app, &state);
    state.send(IrcCommand::Reconnect);
    state.auth_status()
}

/// Choose which optional permission groups the next sign-in asks Twitch for.
///
/// Deliberately *not* a sign-out, unlike changing the Client ID: the token in
/// hand is still perfectly good for everything it already covers. Scopes can
/// only be added by going through the consent screen again, so the account
/// panel says so and offers the button -- turning a group on here and never
/// signing in again simply leaves those commands unavailable, which is what
/// the granted scopes will keep reporting.
#[tauri::command]
fn set_permission_groups(
    app: AppHandle,
    state: State<'_, Shared>,
    groups: Vec<String>,
) -> AuthStatus {
    // Ids we don't know are dropped rather than stored: they'd do nothing at
    // sign-in and would sit in the settings file looking meaningful.
    let known: Vec<String> = groups
        .into_iter()
        .filter(|id| auth::PERMISSION_GROUPS.iter().any(|group| group.id == id && !group.required))
        .collect();

    state.auth.write().permission_groups = known;
    persist(&app, &state);
    state.auth_status()
}

/// Run a slash command in a channel.
///
/// Twitch stopped accepting these over IRC in 2023, so each one is a Helix
/// call -- see `twitch::commands`. The `Ok` string is the line the frontend
/// prints into the channel; an `Err` reaches the composer with your text still
/// in it, since the usual cause is an argument to fix rather than a message to
/// retype.
#[tauri::command]
async fn run_chat_command(
    state: State<'_, Shared>,
    channel: String,
    input: String,
) -> Result<String, String> {
    let name = normalize_channel(&channel)?;
    let Some((command, args)) = twitch::commands::split_command(&input) else {
        return Err("That isn't a command".to_string());
    };

    let (client_id, token, user_id) = {
        let auth = state.auth.read();
        let Some((client_id, token)) = auth.credentials() else {
            return Err(format!("Sign in to use /{command}"));
        };
        let Some(user_id) = auth.user_id.clone() else {
            return Err("Sign in again to refresh permissions".to_string());
        };
        (client_id, token, user_id)
    };

    // Every command is scoped to a channel, and the broadcaster id is what
    // Helix identifies one by -- it arrives with ROOMSTATE, so a channel still
    // connecting has none yet.
    let broadcaster_id = state.data.read().get(&name).and_then(|c| c.room_id.clone());
    let Some(broadcaster_id) = broadcaster_id else {
        return Err("Channel isn't ready yet".to_string());
    };

    let helix = twitch::helix::Helix { client: &state.http, client_id: &client_id, token: &token };
    let context = twitch::commands::Context {
        helix: &helix,
        channel: &name,
        broadcaster_id: &broadcaster_id,
        user_id: &user_id,
    };

    twitch::commands::run(&context, &command, args).await.map_err(|e| e.to_string())
}

/// How often to re-ask Twitch who's live. Cheap -- one request covers every
/// joined channel -- but a stream going up isn't urgent enough to poll harder.
const LIVE_POLL_SECS: u64 = 60;

/// Keep the tab bar's live dots current.
///
/// Ticks on an interval, and also whenever `live_poll` is notified, so joining
/// a channel lights its dot immediately instead of at the next tick. A failed
/// request changes nothing: the previous answer stands rather than every tab
/// blinking offline because one call timed out.
async fn poll_live(app: AppHandle, state: Shared) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(LIVE_POLL_SECS));
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = state.live_poll.notified() => {}
        }

        let (credentials, logins) = {
            let auth = state.auth.read();
            (auth.credentials(), state.channels.read().clone())
        };

        // Signed out we can't ask, so nothing is claimed live. Clearing matters
        // on sign-out: stale dots would otherwise sit there indefinitely.
        let live = match credentials {
            Some((client_id, token)) if !logins.is_empty() => {
                match twitch::streams::fetch_live(&state.http, &client_id, &token, &logins).await {
                    Ok(live) => live,
                    Err(_) => continue,
                }
            }
            _ => HashSet::new(),
        };

        let changed = {
            let mut current = state.live.write();
            if *current == live {
                false
            } else {
                *current = live.clone();
                true
            }
        };
        // Only on a change: this runs every minute forever, and an unchanged
        // payload would re-render every tab for nothing.
        if changed {
            let _ = app.emit("chat://live", live.iter().collect::<Vec<_>>());
        }
    }
}

/// Channel suggestions for the join dialog.
///
/// Empty rather than an error when signed out: Helix has no unauthenticated
/// channel search and this app can't mint an app token (that needs the client
/// secret it deliberately never has), so there's simply nothing to look in.
/// The dialog knows the sign-in state and says so itself.
#[tauri::command]
async fn search_channels(
    state: State<'_, Shared>,
    query: String,
) -> Result<Vec<twitch::search::ChannelHit>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let Some((client_id, token)) = ({ state.auth.read().credentials() }) else {
        return Ok(Vec::new());
    };

    twitch::search::search_channels(&state.http, &client_id, &token, &trimmed)
        .await
        .map_err(|e| e.to_string())
}

/// Everything the card behind a clicked username shows. Signed out this still
/// answers -- the follow and sub half never needed a token, and the avatar and
/// account age fall back to a source that doesn't either.
#[tauri::command]
async fn user_card(
    state: State<'_, Shared>,
    login: String,
    channel: String,
) -> Result<usercard::UserCard, String> {
    let credentials = { state.auth.read().credentials() };
    usercard::fetch(
        &state.http,
        credentials,
        &login.to_ascii_lowercase(),
        &channel.to_ascii_lowercase(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_device_auth(state: State<'_, Shared>) -> Result<auth::DeviceCode, String> {
    let (client_id, scopes) = {
        let auth_state = state.auth.read();
        (
            auth_state.client_id().map(str::to_string),
            auth::scope_string(&auth_state.permission_groups),
        )
    };
    let client_id = client_id.ok_or("Set a Twitch Client ID first")?;

    auth::start_device(&state.http, &client_id, &scopes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn poll_device_auth(
    app: AppHandle,
    state: State<'_, Shared>,
    device_code: String,
) -> Result<Value, String> {
    let (client_id, scopes) = {
        let auth_state = state.auth.read();
        (
            auth_state.client_id().map(str::to_string),
            auth::scope_string(&auth_state.permission_groups),
        )
    };
    let client_id = client_id.ok_or("Set a Twitch Client ID first")?;

    let outcome = auth::poll_device(&state.http, &client_id, &scopes, &device_code)
        .await
        .map_err(|e| e.to_string())?;

    match outcome {
        auth::PollOutcome::Pending => Ok(json!({ "status": "pending" })),
        auth::PollOutcome::Failed(detail) => Ok(json!({ "status": "failed", "detail": detail })),
        auth::PollOutcome::Granted(tokens) => {
            let validation = auth::validate(&state.http, &tokens.access_token)
                .await
                .map_err(|e| e.to_string())?;

            {
                let mut auth_state = state.auth.write();
                auth_state.access_token = Some(tokens.access_token);
                auth_state.refresh_token = Some(tokens.refresh_token);
                auth_state.login = Some(validation.login.clone());
                auth_state.user_id = Some(validation.user_id.clone());
                // What was actually granted, which can be less than we asked
                // for: the consent screen lets scopes be declined.
                auth_state.scopes = validation.scopes.clone();
            }
            persist(&app, &state);

            // Badges need a token, so refetch everything and reconnect as the user.
            let shared: Shared = Arc::clone(&state);
            for data in state.data.write().values_mut() {
                data.ready = false;
            }
            tauri::async_runtime::spawn(client::load_global_assets(app.clone(), shared));
            state.send(IrcCommand::Reconnect);
            // We can ask about live status now that there's a token, and the
            // whisper socket has one to subscribe with.
            state.live_poll.notify_one();
            state.eventsub_restart.notify_one();

            Ok(json!({ "status": "granted", "login": validation.login }))
        }
    }
}

#[tauri::command]
fn logout(app: AppHandle, state: State<'_, Shared>) -> AuthStatus {
    clear_session(&state);
    // Whether we can ask about live status -- or listen for whispers -- at all
    // just changed.
    state.live_poll.notify_one();
    state.eventsub_restart.notify_one();
    persist(&app, &state);
    state.send(IrcCommand::Reconnect);
    state.auth_status()
}

/// Everything the composer and the emote picker need. The entries arrive
/// alphabetically and the counts are applied on top by the UI, so neither a
/// completion nor a search waits on a round trip mid-keystroke.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EmoteIndex {
    entries: Vec<state::EmoteEntry>,
    uses: std::collections::HashMap<String, u32>,
}

#[tauri::command]
fn emote_index(state: State<'_, Shared>, channel: String) -> Result<EmoteIndex, String> {
    let name = normalize_channel(&channel)?;
    Ok(EmoteIndex {
        entries: state.emote_entries(&name),
        uses: state.emote_uses.read().clone(),
    })
}

/// Bump the send count for emotes that went out in a message. Counts are kept
/// per emote name across every channel: the same emote is usually the same
/// emote wherever you are, and habits carry into a freshly joined channel.
#[tauri::command]
fn record_emote_uses(
    app: AppHandle,
    state: State<'_, Shared>,
    channel: String,
    names: Vec<String>,
) -> Result<(), String> {
    let channel = normalize_channel(&channel)?;
    if state.record_emote_uses(&channel, &names) {
        persist(&app, &state);
    }
    Ok(())
}

#[tauri::command]
fn list_channels(state: State<'_, Shared>) -> Vec<String> {
    state.channels.read().clone()
}

#[tauri::command]
fn join_channel(
    app: AppHandle,
    state: State<'_, Shared>,
    channel: String,
) -> Result<Vec<String>, String> {
    let name = normalize_channel(&channel)?;

    {
        let mut channels = state.channels.write();
        if channels.contains(&name) {
            return Ok(channels.clone());
        }
        channels.push(name.clone());
    }

    state.data.write().entry(name.clone()).or_default();
    state.send(IrcCommand::Join(name));
    // Ask who's live now rather than leaving the new tab dotless until the
    // poller's next tick.
    state.live_poll.notify_one();
    persist(&app, &state);

    Ok(state.channels.read().clone())
}

#[tauri::command]
fn part_channel(
    app: AppHandle,
    state: State<'_, Shared>,
    channel: String,
) -> Result<Vec<String>, String> {
    let name = normalize_channel(&channel)?;

    state.channels.write().retain(|c| c != &name);
    state.data.write().remove(&name);
    state.send(IrcCommand::Part(name));
    persist(&app, &state);

    Ok(state.channels.read().clone())
}

/// Apply a drag-to-reorder from the tab bar. `channels` is the full requested
/// order; anything not actually in our channel set is dropped, and any of our
/// channels the caller's list left out are appended, so a stale or partial
/// list can never make a channel disappear.
#[tauri::command]
fn reorder_channels(app: AppHandle, state: State<'_, Shared>, channels: Vec<String>) -> Vec<String> {
    let mut ordered = state.channels.write();
    let mut next: Vec<String> = channels.into_iter().filter(|c| ordered.contains(c)).collect();
    for channel in ordered.iter() {
        if !next.contains(channel) {
            next.push(channel.clone());
        }
    }
    *ordered = next.clone();
    drop(ordered);
    persist(&app, &state);
    next
}

#[tauri::command]
async fn send_message(
    state: State<'_, Shared>,
    channel: String,
    text: String,
    reply_to_id: Option<String>,
) -> Result<(), String> {
    let name = normalize_channel(&channel)?;
    let (_, _, wire_text) = prepare_outgoing(&text)?;

    let (client_id, token, user_id) = {
        let auth = state.auth.read();
        let Some((client_id, token)) = auth.credentials() else {
            return Err("Sign in to send messages".to_string());
        };
        let Some(user_id) = auth.user_id.clone() else {
            return Err("Sign in again to refresh permissions".to_string());
        };
        (client_id, token, user_id)
    };

    let broadcaster_id = state.data.read().get(&name).and_then(|c| c.room_id.clone());
    let Some(broadcaster_id) = broadcaster_id else {
        return Err("Channel isn't ready yet".to_string());
    };

    // Sent via Helix rather than a raw IRC PRIVMSG so a later reply can
    // reference the id Twitch assigns it (IRC never hands that back to us).
    // No local echo here: Twitch broadcasts this back to us over the same IRC
    // connection, exactly like a channel message from anyone else, so it
    // renders through the normal incoming-PRIVMSG path -- color, badges, and
    // (for a reply) the quoted parent all come from that message's own tags.
    chat::send(
        &state.http,
        &client_id,
        &token,
        &broadcaster_id,
        &user_id,
        &wire_text,
        reply_to_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// The macOS menu bar, minus a Close Window item.
///
/// Tauri installs a default menu on macOS (and only there -- every other
/// platform leaves the accelerators to the page), and it binds `Cmd+W` to
/// closing the *window*, twice: File and Window both carry the item. A menu
/// key equivalent is matched before the keystroke ever reaches the webview,
/// so leaving it in place means the frontend's close-tab shortcut can never
/// fire -- the window would just vanish instead. This is the default menu with
/// that one item dropped; everything else, `Cmd+Q` and the Edit items that
/// make copy and paste work in the composer included, is kept as it was.
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Only macOS gets one: Tauri leaves every other platform menu-less, where
    // the keystrokes reach the page on their own.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu);

    builder
        // Emote images are served from disk and downloaded on a miss, so a
        // busy channel re-renders the same emotes without re-hitting the CDN.
        // Failures answer 404 and the frontend falls back to the CDN url.
        .register_asynchronous_uri_scheme_protocol("emote", |app, request, responder| {
            let app = app.app_handle().clone();
            let key = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn(async move {
                let response = match emotes::cache::serve(&app, &key).await {
                    Ok((bytes, mime)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Cache-Control", "max-age=31536000, immutable")
                        .body(bytes),
                    Err(error) => {
                        eprintln!("emote cache: {key}: {error}");
                        tauri::http::Response::builder().status(404).body(Vec::new())
                    }
                };
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let shared: Shared = Arc::new(AppState::new());

            // Restore the previous session.
            let saved = settings::load(&handle);
            {
                let mut auth_state = shared.auth.write();
                auth_state.client_id_override = saved.client_id_override;
                auth_state.access_token = saved.access_token;
                auth_state.refresh_token = saved.refresh_token;
                auth_state.login = saved.login;
                auth_state.user_id = saved.user_id;
                auth_state.scopes = saved.scopes;
                auth_state.permission_groups = saved.permission_groups;
            }
            *shared.emote_uses.write() = saved.emote_uses;
            *shared.preferences.write() = saved.preferences;
            {
                let mut channels = shared.channels.write();
                let mut data = shared.data.write();
                for channel in saved.channels {
                    data.entry(channel.clone()).or_default();
                    channels.push(channel);
                }
            }

            let (tx, rx) = mpsc::unbounded_channel::<IrcCommand>();
            *shared.commands.write() = Some(tx);

            // 7TV answers "who has which badge" one user at a time, so chatters
            // queue here and go out in batches.
            let (badge_tx, badge_rx) = mpsc::unbounded_channel::<String>();
            *shared.badge_lookups.write() = Some(badge_tx);
            tauri::async_runtime::spawn(emotes::seventv_badges::run(
                handle.clone(),
                Arc::clone(&shared),
                badge_rx,
            ));

            let sink = client::spawn_emitter(handle.clone());

            tauri::async_runtime::spawn(restore_session(handle.clone(), Arc::clone(&shared)));
            tauri::async_runtime::spawn(poll_live(handle.clone(), Arc::clone(&shared)));
            // Whispers arrive on their own socket -- Twitch doesn't send them
            // over IRC -- but through the same sink, so they batch with chat.
            tauri::async_runtime::spawn(twitch::eventsub::run(
                Arc::clone(&shared),
                sink.clone(),
            ));
            tauri::async_runtime::spawn(client::run(
                handle.clone(),
                Arc::clone(&shared),
                sink,
                rx,
            ));

            app.manage(shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            set_client_id_override,
            set_permission_groups,
            run_chat_command,
            search_channels,
            user_card,
            start_device_auth,
            poll_device_auth,
            logout,
            list_channels,
            join_channel,
            part_channel,
            reorder_channels,
            send_message,
            preferences,
            set_preferences,
            emote_index,
            record_emote_uses,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{normalize_channel, prepare_outgoing};

    #[test]
    fn accepts_and_lowercases_plain_names() {
        assert_eq!(normalize_channel("Forsen").unwrap(), "forsen");
    }

    #[test]
    fn strips_leading_hash_and_at() {
        assert_eq!(normalize_channel("#forsen").unwrap(), "forsen");
        assert_eq!(normalize_channel("@forsen").unwrap(), "forsen");
        assert_eq!(normalize_channel("  #Forsen  ").unwrap(), "forsen");
    }

    #[test]
    fn rejects_invalid_names() {
        assert!(normalize_channel("").is_err());
        assert!(normalize_channel("ab").is_err());
        assert!(normalize_channel("has spaces").is_err());
        assert!(normalize_channel("bad-dash").is_err());
    }

    #[test]
    fn allows_underscores_and_digits() {
        assert_eq!(normalize_channel("some_user123").unwrap(), "some_user123");
    }

    #[test]
    fn empty_or_whitespace_only_messages_are_rejected() {
        assert!(prepare_outgoing("").is_err());
        assert!(prepare_outgoing("   ").is_err());
    }

    #[test]
    fn overlong_messages_are_rejected() {
        let long = "a".repeat(501);
        assert!(prepare_outgoing(&long).is_err());
        let max = "a".repeat(500);
        assert!(prepare_outgoing(&max).is_ok());
    }

    #[test]
    fn carriage_returns_and_newlines_are_stripped() {
        let (_, _, wire) = prepare_outgoing("hi\r\nPART #forsen").unwrap();
        assert_eq!(wire, "hiPART #forsen");
    }

    #[test]
    fn slash_me_becomes_a_ctcp_action() {
        let (is_action, body, wire) = prepare_outgoing("/me waves hello").unwrap();
        assert!(is_action);
        assert_eq!(body, "waves hello");
        assert_eq!(wire, "\u{1}ACTION waves hello\u{1}");
    }

    #[test]
    fn slash_me_with_no_body_is_not_an_action() {
        // Trailing whitespace is trimmed first, so "/me" alone never matches
        // the "/me " prefix -- it's sent as the literal text "/me".
        let (is_action, body, _) = prepare_outgoing("/me").unwrap();
        assert!(!is_action);
        assert_eq!(body, "/me");
    }

    #[test]
    fn ordinary_text_passes_through_unchanged() {
        let (is_action, body, wire) = prepare_outgoing("  hello chat  ").unwrap();
        assert!(!is_action);
        assert_eq!(body, "hello chat");
        assert_eq!(wire, "hello chat");
    }
}
