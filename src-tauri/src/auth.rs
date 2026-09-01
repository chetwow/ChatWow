//! Twitch OAuth Device Code Flow.
//!
//! The app is registered as a *public* client, so there is no client secret --
//! we exchange a device code for tokens and refresh the same way.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";

/// `user:write:chat` is what lets us send through Helix's chat-messages
/// endpoint instead of raw IRC PRIVMSG -- the only way to learn the real id
/// Twitch assigns an outgoing message (IRC never echoes it back to us), which
/// in turn is what makes replying to your own messages work.
pub const SCOPES: &str = "chat:read chat:edit user:write:chat";

/// The Client ID baked in at build time:
///
///   TWITCH_CLIENT_ID=<id> npm run tauri build
///
/// A Client ID is a public identifier, not a secret -- it travels in the clear
/// on every OAuth request, so shipping it in the binary is the intended usage.
/// The client *secret* is the confidential half, and the device code flow never
/// needs one, which is exactly why this app is registered as a public client.
///
/// When it's absent (a plain `cargo build` during development) the app falls
/// back to a Client ID pasted into the account dialog.
pub const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("TWITCH_CLIENT_ID");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Validation {
    pub login: String,
    pub user_id: String,
}

#[derive(Debug)]
pub enum PollOutcome {
    Pending,
    Granted(Tokens),
    Failed(String),
}

pub async fn start_device(client: &reqwest::Client, client_id: &str) -> Result<DeviceCode> {
    let response = client
        .post(DEVICE_URL)
        .form(&[("client_id", client_id), ("scopes", SCOPES)])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(anyhow!("Twitch rejected the device request ({status}): {body}"));
    }
    serde_json::from_str(&body)
        .map_err(|e| anyhow!("unexpected device response: {e} -- body was {body}"))
}

pub async fn poll_device(
    client: &reqwest::Client,
    client_id: &str,
    device_code: &str,
) -> Result<PollOutcome> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("scopes", SCOPES),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if status.is_success() {
        return Ok(PollOutcome::Granted(serde_json::from_str(&body)?));
    }

    // Twitch reports "authorization_pending" while the user has not approved yet.
    // It signals this in the message field rather than a distinct status code.
    let lowered = body.to_ascii_lowercase();
    if lowered.contains("authorization_pending") || lowered.contains("pending") {
        return Ok(PollOutcome::Pending);
    }
    if lowered.contains("slow_down") {
        return Ok(PollOutcome::Pending);
    }
    Ok(PollOutcome::Failed(body))
}

pub async fn refresh(
    client: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<Tokens> {
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}

/// Confirms a stored token is still good and tells us which account it belongs to.
pub async fn validate(client: &reqwest::Client, token: &str) -> Result<Validation> {
    let response = client
        .get(VALIDATE_URL)
        .header("Authorization", format!("OAuth {token}"))
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}
