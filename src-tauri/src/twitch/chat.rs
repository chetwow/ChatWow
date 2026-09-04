//! Sending chat messages via Twitch's Helix API.
//!
//! A raw IRC PRIVMSG can't carry a reply-parent-msg-id that resolves to a
//! message *we* sent: Twitch never echoes our own PRIVMSGs back to us over
//! IRC, so we'd have no real id to reference in the first place. Sending
//! through Helix instead means Twitch validates the reply target and confirms
//! (or rejects, e.g. an AutoMod hold) the send in the same response -- we
//! don't render anything ourselves off the back of it. The sent message
//! itself arrives back through the normal incoming-PRIVMSG path, the same way
//! it does for everyone else in the channel.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

const SEND_URL: &str = "https://api.twitch.tv/helix/chat/messages";

#[derive(Debug, Serialize)]
struct SendRequest<'a> {
    broadcaster_id: &'a str,
    sender_id: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_parent_message_id: Option<&'a str>,
}

#[derive(Debug, Default, Deserialize)]
struct SendResponse {
    #[serde(default)]
    data: Vec<SentMessage>,
}

#[derive(Debug, Deserialize)]
struct SentMessage {
    is_sent: bool,
    drop_reason: Option<DropReason>,
}

#[derive(Debug, Deserialize)]
struct DropReason {
    #[serde(default)]
    message: String,
}

fn resolve(response: SendResponse) -> Result<()> {
    let sent = response
        .data
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Twitch sent no result"))?;
    if !sent.is_sent {
        let reason = sent
            .drop_reason
            .and_then(|d| (!d.message.is_empty()).then_some(d.message))
            .unwrap_or_else(|| "Twitch declined to send the message".to_string());
        return Err(anyhow!(reason));
    }
    Ok(())
}

/// Sends a chat message. Twitch confirms (or rejects) the send in the
/// response; the sent message itself arrives separately over IRC.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    broadcaster_id: &str,
    sender_id: &str,
    message: &str,
    reply_parent_message_id: Option<&str>,
) -> Result<()> {
    let response = client
        .post(SEND_URL)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .json(&SendRequest {
            broadcaster_id,
            sender_id,
            message,
            reply_parent_message_id,
        })
        .send()
        .await?
        .error_for_status()?
        .json::<SendResponse>()
        .await?;

    resolve(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sent_message_resolves_ok() {
        let json = r#"{"data":[{"message_id":"abc-123","is_sent":true,"drop_reason":null}]}"#;
        let response: SendResponse = serde_json::from_str(json).unwrap();
        assert!(resolve(response).is_ok());
    }

    #[test]
    fn a_dropped_message_surfaces_its_reason() {
        let json = r#"{"data":[{"message_id":"abc-123","is_sent":false,
            "drop_reason":{"code":"channel_settings","message":"Your message wasn't sent because you don't have permission."}}]}"#;
        let response: SendResponse = serde_json::from_str(json).unwrap();
        let error = resolve(response).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Your message wasn't sent because you don't have permission."
        );
    }

    #[test]
    fn a_dropped_message_with_no_reason_gets_a_fallback() {
        let json = r#"{"data":[{"message_id":"abc-123","is_sent":false,"drop_reason":null}]}"#;
        let response: SendResponse = serde_json::from_str(json).unwrap();
        let error = resolve(response).unwrap_err();
        assert_eq!(error.to_string(), "Twitch declined to send the message");
    }
}
