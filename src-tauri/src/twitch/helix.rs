//! A thin Helix client for the endpoints behind chat commands.
//!
//! Twitch retired the IRC chat commands in 2023: `/ban`, `/timeout`, `/slow`
//! and the rest are HTTP calls now, each behind its own scope. They share
//! enough shape -- a Client-Id, a bearer token, and an error body whose
//! `message` is the sentence worth showing -- to be worth one wrapper rather
//! than a module per endpoint.

use anyhow::{anyhow, Result};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::Value;

const BASE: &str = "https://api.twitch.tv/helix/";

pub struct Helix<'a> {
    pub client: &'a reqwest::Client,
    pub client_id: &'a str,
    pub token: &'a str,
}

/// Twitch's error body. `message` is written for a human ("Missing scope:
/// moderator:manage:banned_users", "The user is not a moderator"), which is
/// exactly what a failed command should say.
#[derive(Debug, Default, Deserialize)]
struct HelixError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    error: String,
}

/// The most useful sentence we can get out of a failed response. Twitch is
/// good about `message`, but a proxy or an outage can answer with something
/// that isn't JSON at all, so the status is always there to fall back on.
fn error_message(status: StatusCode, body: &str) -> String {
    let parsed: HelixError = serde_json::from_str(body).unwrap_or_default();
    if !parsed.message.is_empty() {
        return parsed.message;
    }
    if !parsed.error.is_empty() {
        return format!("{} ({})", parsed.error, status.as_u16());
    }
    format!("Twitch answered {}", status.as_u16())
}

impl<'a> Helix<'a> {
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{BASE}{path}"))
            .header("Client-Id", self.client_id)
            .bearer_auth(self.token)
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await?;

        if !status.is_success() {
            return Err(anyhow!(error_message(status, &text)));
        }
        // 204 No Content is the norm for these endpoints -- most of them
        // answer with nothing at all, and only the getters return data.
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.request(Method::GET, path, query, None).await
    }

    pub async fn post(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value> {
        self.request(Method::POST, path, query, body).await
    }

    pub async fn patch(&self, path: &str, query: &[(&str, &str)], body: Value) -> Result<Value> {
        self.request(Method::PATCH, path, query, Some(body)).await
    }

    pub async fn put(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.request(Method::PUT, path, query, None).await
    }

    pub async fn delete(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.request(Method::DELETE, path, query, None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_scope_reads_back_as_twitch_wrote_it() {
        let body = r#"{"error":"Unauthorized","status":401,
            "message":"Missing scope: moderator:manage:banned_users"}"#;
        assert_eq!(
            error_message(StatusCode::UNAUTHORIZED, body),
            "Missing scope: moderator:manage:banned_users"
        );
    }

    #[test]
    fn an_error_with_no_message_falls_back_to_the_error_and_status() {
        let body = r#"{"error":"Forbidden","status":403}"#;
        assert_eq!(
            error_message(StatusCode::FORBIDDEN, body),
            "Forbidden (403)"
        );
    }

    #[test]
    fn a_body_that_isnt_json_still_says_something() {
        // A proxy or an outage can answer with HTML; the status is all we have.
        let message = error_message(StatusCode::BAD_GATEWAY, "<html>nope</html>");
        assert_eq!(message, "Twitch answered 502");
    }
}
