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
mod linkinfo;
mod usercard;

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::irc::client;
use crate::settings::{Tab, ANONYMOUS};
use crate::state::{AppState, AuthStatus};
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
        accounts: auth.accounts.clone(),
        default_account: auth.default_account.clone(),
        permission_groups: auth.permission_groups.clone(),
        tabs: state.tabs.read().clone(),
        emote_uses: state.emote_uses.read().clone(),
        preferences: state.preferences.read().clone(),
        ..Default::default()
    };
    drop(auth);
    if let Err(error) = settings::save(app, &settings) {
        eprintln!("failed to save settings: {error}");
    }
}

/// Tabs, and the connections that follow from them, after a change. Every
/// command that touches the list ends here.
fn tabs_changed(app: &AppHandle, state: &Shared) -> Vec<Tab> {
    persist(app, state);
    client::sync(app, state);
    // A channel that has just appeared should get its live dot now rather than
    // up to a poll period later.
    state.live_poll.notify_one();
    state.tabs.read().clone()
}

/// How often to look at every stored token.
///
/// Twitch asks that a token be validated at least hourly, and this is that
/// check as much as it is the refresh -- an hour is often enough to catch an
/// expiry well before it arrives, and rare enough to be invisible.
const TOKEN_CHECK_SECS: u64 = 60 * 60;

/// Renew a token once it has less than this much life left.
///
/// Has to stay comfortably larger than `TOKEN_CHECK_SECS`: a margin narrower
/// than the gap between checks would let a token die between two of them,
/// which is the entire failure this exists to prevent.
const REFRESH_MARGIN_SECS: u64 = 90 * 60;

/// What looking at one account's token came to.
enum TokenCheck {
    /// Nothing to write down -- either nothing had changed, or Twitch couldn't
    /// be reached and we know no more than we did.
    Unchanged,
    /// The same token still, but Twitch named a login or a scope set we
    /// weren't storing.
    Validated,
    /// A new access token is stored.
    Renewed,
    /// The grant is gone, and the account with it.
    Lost,
}

/// Validate one account's token, renewing it if Twitch says it has expired or
/// is close to it, and write whatever we learn back into `state`.
///
/// The one place a stored token is ever refreshed: startup and the hourly
/// poller both come here, so an account can't end up recovered one way at
/// launch and another way an hour later.
///
/// An account Twitch has *refused* is removed rather than kept as a dead
/// entry: its tabs fall back to anonymous, which is a state the app can
/// actually be in, where a signed-in account that can do nothing isn't. An
/// account we merely couldn't ask about is left exactly as it was.
async fn check_token(state: &Shared, account: &settings::Account) -> TokenCheck {
    let client_id = { state.auth.read().client_id().map(str::to_string) };

    // A token with life left in it needs nothing beyond what validating it
    // just told us. Twitch is the authority on the login and the scopes, and
    // both can have changed since we last looked -- ids are what we key on for
    // exactly that reason.
    if let Ok(validation) = auth::validate(&state.http, &account.access_token).await {
        if validation.expires_in > REFRESH_MARGIN_SECS {
            let mut auth_state = state.auth.write();
            let Some(stored) = auth_state.accounts.iter_mut().find(|a| a.id == account.id) else {
                return TokenCheck::Unchanged;
            };
            // Only claim a change when there is one. This runs every hour, and
            // an unconditional yes would mean rewriting the settings file and
            // waking the frontend hourly to tell it nothing.
            let differs = stored.login != validation.login || stored.scopes != validation.scopes;
            stored.login = validation.login;
            stored.scopes = validation.scopes;
            return if differs { TokenCheck::Validated } else { TokenCheck::Unchanged };
        }
    }

    // No Client ID to refresh against isn't the account's fault and isn't
    // something dropping it would fix.
    let Some(client_id) = client_id else {
        return TokenCheck::Unchanged;
    };

    let tokens = match auth::refresh(&state.http, &client_id, &account.refresh_token).await {
        auth::RefreshOutcome::Renewed(tokens) => tokens,
        auth::RefreshOutcome::Unreachable(reason) => {
            // Worth saying out loud even though nothing changes: a token that
            // keeps failing to renew is the shape of the bug this poller was
            // written for, and silence is how it went unnoticed the first time.
            eprintln!("couldn't renew {}'s token, will retry: {reason}", account.login);
            return TokenCheck::Unchanged;
        }
        auth::RefreshOutcome::Rejected(reason) => {
            eprintln!("signing {} out -- Twitch rejected the refresh: {reason}", account.login);
            let mut auth_state = state.auth.write();
            auth_state.accounts.retain(|a| a.id != account.id);
            if auth_state.default_account == account.id {
                auth_state.default_account = ANONYMOUS.to_string();
            }
            return TokenCheck::Lost;
        }
    };

    // The new token is only worth storing once Twitch has said what it
    // carries: the scopes decide which commands the picker offers, and a
    // refresh that produced an unusable token is a refresh that failed.
    let Ok(validation) = auth::validate(&state.http, &tokens.access_token).await else {
        return TokenCheck::Unchanged;
    };

    let mut auth_state = state.auth.write();
    let Some(stored) = auth_state.accounts.iter_mut().find(|a| a.id == account.id) else {
        return TokenCheck::Unchanged;
    };
    stored.access_token = tokens.access_token;
    // Twitch normally issues a fresh refresh token alongside; when it doesn't,
    // the one we hold stays valid and must not be overwritten with nothing.
    if !tokens.refresh_token.is_empty() {
        stored.refresh_token = tokens.refresh_token;
    }
    stored.login = validation.login;
    stored.scopes = validation.scopes;
    TokenCheck::Renewed
}

/// Check every stored token on startup, refreshing the ones that have expired
/// or are about to, then load global assets.
///
/// The margin matters here as much as in the poller: an app opened half an
/// hour before its token dies would otherwise start with a token that expires
/// long before the first hourly check.
async fn restore_session(app: AppHandle, state: Shared) {
    let accounts = { state.auth.read().accounts.clone() };
    // Something worth writing down and telling the UI about.
    let mut changed = false;
    // A token that is *not* the one the sockets are being built with. Kept
    // apart from `changed` deliberately: re-validating a good token rewrites
    // its scopes and its login, which is worth persisting but is no reason to
    // drop the connections. Reconnecting the whisper socket on every launch
    // leaves the old subscription behind on Twitch's side, and three of those
    // is the limit for one type and condition -- after which it refuses, and
    // whispers silently stop arriving.
    let mut credentials_changed = false;

    for account in accounts {
        match check_token(&state, &account).await {
            TokenCheck::Unchanged => {}
            TokenCheck::Validated => changed = true,
            TokenCheck::Renewed | TokenCheck::Lost => {
                changed = true;
                credentials_changed = true;
            }
        }
    }

    if changed {
        persist(&app, &state);
        let _ = app.emit("chat://auth", state.auth_status());
    }
    if credentials_changed {
        // Tabs whose account has just gone read anonymously from here on, and
        // the ones whose token was refreshed need the socket to use the new one.
        client::reconnect_all(&state);
        state.eventsub_restart.notify_one();
    }

    client::load_global_assets(app, state).await;
}

/// Keep every stored token alive for as long as the app is open.
///
/// Twitch's user tokens last hours and a chat client is left running for
/// longer, so without this a session eventually reaches the point where every
/// Helix call -- sending a message included -- answers 401, with nothing short
/// of signing in again to fix it. IRC hides how broken that is: a connection
/// authenticates once, at connect, so chat keeps arriving while everything
/// that needs a token has quietly stopped working.
async fn poll_tokens(app: AppHandle, state: Shared) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(TOKEN_CHECK_SECS));
    // `interval` fires its first tick immediately, and `restore_session` is
    // making this very pass right now. Two refreshes racing on one account
    // would be worse than neither: the second would present a refresh token
    // the first had already spent, and Twitch refusing that reads exactly like
    // a dead grant -- so the account would be signed out for succeeding.
    ticker.tick().await;

    loop {
        ticker.tick().await;

        let accounts = { state.auth.read().accounts.clone() };
        let mut changed = false;
        let mut lost = false;
        for account in accounts {
            match check_token(&state, &account).await {
                TokenCheck::Unchanged => {}
                TokenCheck::Validated | TokenCheck::Renewed => changed = true,
                TokenCheck::Lost => {
                    changed = true;
                    lost = true;
                }
            }
        }

        if changed {
            persist(&app, &state);
            let _ = app.emit("chat://auth", state.auth_status());
        }
        if lost {
            // Only a *lost* account touches the sockets, unlike at startup. A
            // renewed token doesn't need to: an IRC connection authenticates
            // once and Twitch leaves it alone afterwards, and whenever it does
            // next reconnect `connect_once` reads the new token from here.
            // Reconnecting the whisper socket, meanwhile, orphans its EventSub
            // subscription, and three of those is Twitch's limit.
            client::reconnect_all(&state);
            state.eventsub_restart.notify_one();
        }
    }
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
/// Drop every account. Tabs fall back to anonymous, as they do when a single
/// account is removed -- see `remove_account`.
fn clear_session(state: &AppState) {
    {
        let mut auth_state = state.auth.write();
        auth_state.accounts.clear();
        auth_state.default_account = ANONYMOUS.to_string();
    }
    for tab in state.tabs.write().iter_mut() {
        tab.account = ANONYMOUS.to_string();
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
    client::sync(&app, &state);
    client::reconnect_all(&state);
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
    account: String,
    channel: String,
    input: String,
) -> Result<String, String> {
    let name = normalize_channel(&channel)?;
    let Some((command, args)) = twitch::commands::split_command(&input) else {
        return Err("That isn't a command".to_string());
    };

    // Run as the tab's account: whether this one can time somebody out here is
    // its own question, answered by its own token.
    let (client_id, token, user_id) = {
        let auth = state.auth.read();
        let Some((client_id, token)) = auth.credentials(&account) else {
            return Err(format!("Sign in to use /{command}"));
        };
        (client_id, token, account.clone())
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
            let logins: Vec<String> = state.open_channels().into_iter().collect();
            (auth.any_credentials(), logins)
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

    let Some((client_id, token)) = ({ state.auth.read().any_credentials() }) else {
        return Ok(Vec::new());
    };

    twitch::search::search_channels(&state.http, &client_id, &token, &trimmed)
        .await
        .map_err(|e| e.to_string())
}

/// Everything the card behind a clicked username shows. Signed out this still
/// answers -- the follow and sub half never needed a token, and the avatar and
/// account age fall back to a source that doesn't either.
/// What's behind a link, for the hover preview. `None` covers every way
/// there's nothing to show -- no metadata, not a page, a host that refused --
/// because the preview draws the same nothing for all of them.
///
/// Twitch's own links go to Helix first: a twitch.tv page tells a scraper
/// almost nothing, and this app is already holding a token. Everything about
/// that path is best-effort -- signed out there's no token, and a Helix miss or
/// failure is not the end of the answer -- so it falls through to the ordinary
/// page preview rather than reporting an error.
#[tauri::command]
async fn link_preview(
    state: State<'_, Shared>,
    url: String,
) -> Result<Option<linkinfo::LinkPreview>, String> {
    if let Some(link) = reqwest::Url::parse(&url).ok().as_ref().and_then(twitch::links::parse) {
        let credentials = { state.auth.read().any_credentials() };
        if let Some((client_id, token)) = credentials {
            let helix = twitch::helix::Helix {
                client: &state.http,
                client_id: &client_id,
                token: &token,
            };
            match twitch::links::preview(&helix, &link).await {
                Ok(Some(preview)) => return Ok(Some(preview)),
                Ok(None) => {}
                Err(error) => eprintln!("link preview: Helix failed ({error}); reading the page"),
            }
        }
    }

    linkinfo::preview(&state.link_http, &url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_card(
    state: State<'_, Shared>,
    login: String,
    channel: String,
) -> Result<usercard::UserCard, String> {
    let credentials = { state.auth.read().any_credentials() };
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
                let account = settings::Account {
                    id: validation.user_id.clone(),
                    login: validation.login.clone(),
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    // What was actually granted, which can be less than we
                    // asked for: the consent screen lets scopes be declined.
                    scopes: validation.scopes.clone(),
                };
                // Signing the same account in again replaces its tokens rather
                // than listing it twice -- which is how you widen what one
                // account may do, scopes being granted once and only at sign-in.
                match auth_state.accounts.iter_mut().find(|a| a.id == account.id) {
                    Some(existing) => *existing = account,
                    None => auth_state.accounts.push(account),
                }
                // The first account signed in becomes what new tabs use; after
                // that the choice is the settings dialog's to make.
                if auth_state.default_account == ANONYMOUS {
                    auth_state.default_account = validation.user_id.clone();
                }
            }
            persist(&app, &state);

            // Badges need a token, so refetch everything; sockets belonging to
            // this account (a re-sign-in) need to log in again with the new one.
            let shared: Shared = Arc::clone(&state);
            tauri::async_runtime::spawn(client::load_global_assets(app.clone(), shared));
            state.send(&validation.user_id, state::IrcCommand::Reconnect);
            // We can ask about live status now that there's a token, and the
            // whisper socket has one to subscribe with.
            state.live_poll.notify_one();
            state.eventsub_restart.notify_one();
            let _ = app.emit("chat://auth", state.auth_status());

            Ok(json!({ "status": "granted", "login": validation.login }))
        }
    }
}

/// Sign one account out.
///
/// Its tabs stay open and fall back to anonymous: they keep showing the channel
/// they were showing, without a composer that can send. Losing the channels you
/// had open because you signed something out would be a worse trade than a tab
/// that can only read.
#[tauri::command]
fn remove_account(app: AppHandle, state: State<'_, Shared>, id: String) -> AuthStatus {
    {
        let mut auth = state.auth.write();
        auth.accounts.retain(|account| account.id != id);
        if auth.default_account == id {
            auth.default_account = ANONYMOUS.to_string();
        }
    }
    for tab in state.tabs.write().iter_mut().filter(|tab| tab.account == id) {
        tab.account = ANONYMOUS.to_string();
    }
    state.global_badges.write().clear();
    for data in state.data.write().values_mut() {
        data.badges.clear();
    }

    persist(&app, &state);
    // Whether we can ask about live status -- or listen for whispers -- at all
    // may just have changed, and the tabs that moved need their new socket.
    client::sync(&app, &state);
    state.live_poll.notify_one();
    state.eventsub_restart.notify_one();
    state.auth_status()
}

/// Which account a newly opened tab reads as. Anonymous is a legitimate
/// choice here, not just the state before signing in.
#[tauri::command]
fn set_default_account(app: AppHandle, state: State<'_, Shared>, id: String) -> AuthStatus {
    let resolved = resolve_account(&state, &id);
    state.auth.write().default_account = resolved;
    persist(&app, &state);
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
fn emote_index(
    state: State<'_, Shared>,
    account: String,
    channel: String,
) -> Result<EmoteIndex, String> {
    let name = normalize_channel(&channel)?;
    Ok(EmoteIndex {
        entries: state.emote_entries(&account, &name),
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
    account: String,
    channel: String,
    names: Vec<String>,
) -> Result<(), String> {
    let channel = normalize_channel(&channel)?;
    if state.record_emote_uses(&account, &channel, &names) {
        persist(&app, &state);
    }
    Ok(())
}

#[tauri::command]
fn list_tabs(state: State<'_, Shared>) -> Vec<Tab> {
    state.tabs.read().clone()
}

/// Open a tab. The id is the frontend's -- it mints one when it opens the view,
/// so the view has a key from the first frame rather than after a round trip --
/// and everything else is validated here.
///
/// The same channel twice under one account is refused: two identical views of
/// one stream is a mistake, not a feature. Under a *different* account it's the
/// whole point, so that passes.
#[tauri::command]
fn add_tab(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    kind: String,
    channel: String,
    account: String,
) -> Result<Vec<Tab>, String> {
    if id.trim().is_empty() {
        return Err("A tab needs an id".to_string());
    }
    let account = resolve_account(&state, &account);

    let tab = match kind.as_str() {
        "mentions" => Tab { id, kind, channel: String::new(), account },
        _ => {
            let channel = normalize_channel(&channel)?;
            Tab { id, kind: "channel".to_string(), channel, account }
        }
    };

    {
        let mut tabs = state.tabs.write();
        let duplicate = tabs.iter().any(|open| {
            open.id == tab.id
                || (open.kind == tab.kind && open.channel == tab.channel && open.account == tab.account)
        });
        if duplicate {
            return Ok(tabs.clone());
        }
        tabs.push(tab);
    }

    Ok(tabs_changed(&app, &state))
}

#[tauri::command]
fn close_tab(app: AppHandle, state: State<'_, Shared>, id: String) -> Vec<Tab> {
    state.tabs.write().retain(|tab| tab.id != id);
    tabs_changed(&app, &state)
}

/// Read a tab as a different account -- the right-click on a tab, and the one
/// on the composer.
///
/// It stays the same tab: the messages already in it were said in this channel
/// and are just as true under the new login, so only what happens from here on
/// changes. That's a part on one socket and a join on another, which `sync`
/// works out for itself.
#[tauri::command]
fn set_tab_account(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
    account: String,
) -> Vec<Tab> {
    let account = resolve_account(&state, &account);
    {
        let mut tabs = state.tabs.write();
        let Some(moving) = tabs.iter().find(|tab| tab.id == id).cloned() else {
            return tabs.clone();
        };
        if moving.account == account {
            return tabs.clone();
        }
        // Moving a tab onto an account that already has this channel open would
        // make the duplicate `add_tab` refuses, so it's refused here too.
        let taken = tabs.iter().any(|tab| {
            tab.id != id
                && tab.account == account
                && tab.kind == moving.kind
                && tab.channel == moving.channel
        });
        if taken {
            return tabs.clone();
        }
        if let Some(tab) = tabs.iter_mut().find(|tab| tab.id == id) {
            tab.account = account;
        }
    }
    tabs_changed(&app, &state)
}

/// Apply a drag-to-reorder from the tab bar. `ids` is the full requested order;
/// anything not actually open is dropped, and any open tab the caller's list
/// left out is appended, so a stale or partial list can never lose a tab.
#[tauri::command]
fn reorder_tabs(app: AppHandle, state: State<'_, Shared>, ids: Vec<String>) -> Vec<Tab> {
    {
        let mut tabs = state.tabs.write();
        let mut next: Vec<Tab> = ids
            .iter()
            .filter_map(|id| tabs.iter().find(|tab| &tab.id == id).cloned())
            .collect();
        for tab in tabs.iter() {
            if !next.iter().any(|kept| kept.id == tab.id) {
                next.push(tab.clone());
            }
        }
        *tabs = next;
    }
    // Order alone changes no connection, but it does change the file.
    persist(&app, &state);
    state.tabs.read().clone()
}

/// An account id we actually hold, or anonymous. Anything else -- a removed
/// account, a hand-edited settings file -- reads as signed out rather than as
/// an error: a tab pointing at nobody still shows chat.
fn resolve_account(state: &AppState, account: &str) -> String {
    match state.auth.read().account(account) {
        Some(account) => account.id.clone(),
        None => ANONYMOUS.to_string(),
    }
}

#[tauri::command]
async fn send_message(
    state: State<'_, Shared>,
    account: String,
    channel: String,
    text: String,
    reply_to_id: Option<String>,
) -> Result<(), String> {
    let name = normalize_channel(&channel)?;
    let (_, _, wire_text) = prepare_outgoing(&text)?;

    // The sender is the tab's account, not "the" account: the same channel can
    // be open twice, and which composer you typed into is what decides who
    // says it.
    let (client_id, token, user_id) = {
        let auth = state.auth.read();
        let Some((client_id, token)) = auth.credentials(&account) else {
            return Err("Sign in to send messages".to_string());
        };
        (client_id, token, account.clone())
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
                auth_state.accounts = saved.accounts;
                auth_state.default_account = saved.default_account;
                auth_state.permission_groups = saved.permission_groups;
            }
            *shared.emote_uses.write() = saved.emote_uses;
            *shared.preferences.write() = saved.preferences;
            {
                let mut data = shared.data.write();
                for tab in saved.tabs.iter().filter(|tab| tab.is_channel()) {
                    data.entry(tab.channel.clone()).or_default();
                }
            }
            *shared.tabs.write() = saved.tabs;

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
            *shared.sink.write() = Some(sink.clone());

            tauri::async_runtime::spawn(restore_session(handle.clone(), Arc::clone(&shared)));
            tauri::async_runtime::spawn(poll_live(handle.clone(), Arc::clone(&shared)));
            // Tokens outlive neither the app nor a long session on their own.
            tauri::async_runtime::spawn(poll_tokens(handle.clone(), Arc::clone(&shared)));
            // Whispers arrive on their own socket -- Twitch doesn't send them
            // over IRC -- but through the same sink, so they batch with chat.
            // One per signed-in account, since a whisper is addressed to one.
            tauri::async_runtime::spawn(twitch::eventsub::run(
                Arc::clone(&shared),
                sink,
            ));
            // The restored tabs decide which sockets to open, and as whom.
            client::sync(&handle, &shared);

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
            link_preview,
            start_device_auth,
            poll_device_auth,
            remove_account,
            set_default_account,
            list_tabs,
            add_tab,
            close_tab,
            set_tab_account,
            reorder_tabs,
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
    use super::{normalize_channel, prepare_outgoing, REFRESH_MARGIN_SECS, TOKEN_CHECK_SECS};

    #[test]
    fn tokens_are_renewed_further_ahead_than_the_gap_between_checks() {
        // Otherwise a token can expire in the hour between two checks, which
        // is the exact failure the poller exists to prevent.
        assert!(REFRESH_MARGIN_SECS > TOKEN_CHECK_SECS);
    }

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
