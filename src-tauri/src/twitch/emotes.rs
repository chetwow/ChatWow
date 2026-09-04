//! Twitch's own emotes via Helix, for autocomplete and the emote picker.
//!
//! Rendering never needs these: an incoming message's `emotes` IRC tag already
//! carries the id and character range for every Twitch emote in it, so
//! [`crate::render`] resolves them without a lookup table. What the tag can't
//! tell us is which emotes exist *before* anyone sends one, which is exactly
//! what completing a half-typed emote needs -- hence this list, kept apart
//! from the 7TV maps that drive rendering. Folding them into those maps would
//! make us render any word matching a Twitch emote name as that emote, even
//! from someone who doesn't have it.
//!
//! Only id and name are kept: image URLs follow from the id, the same way
//! [`crate::emotes::twitch_emote`] builds them for incoming messages.
//!
//! Both endpoints need a Client-Id and a bearer token, so signed-out users get
//! 7TV completions only.

use anyhow::Result;
use serde::Deserialize;

/// A Twitch emote we can offer as a completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwitchEmote {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct EmoteResponse {
    #[serde(default)]
    data: Vec<EmoteEntry>,
}

#[derive(Deserialize)]
struct EmoteEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

fn emotes(response: EmoteResponse) -> Vec<TwitchEmote> {
    response
        .data
        .into_iter()
        .filter(|e| !e.id.is_empty() && !e.name.is_empty())
        .map(|e| TwitchEmote {
            id: e.id,
            name: e.name,
        })
        .collect()
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
) -> Result<Vec<TwitchEmote>> {
    let response = client
        .get(url)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json::<EmoteResponse>()
        .await?;
    Ok(emotes(response))
}

/// Twitch's global emotes -- Kappa, LUL and friends, usable everywhere.
pub async fn fetch_global(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
) -> Result<Vec<TwitchEmote>> {
    fetch(
        client,
        "https://api.twitch.tv/helix/chat/emotes/global",
        client_id,
        token,
    )
    .await
}

/// A channel's own emotes (subscriber, bits, follower). Returned whether or not
/// we're entitled to use them -- they're still what the channel is talking in.
pub async fn fetch_channel(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    broadcaster_id: &str,
) -> Result<Vec<TwitchEmote>> {
    let url = format!("https://api.twitch.tv/helix/chat/emotes?broadcaster_id={broadcaster_id}");
    fetch(client, &url, client_id, token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emote(id: &str, name: &str) -> TwitchEmote {
        TwitchEmote {
            id: id.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn collects_ids_and_names_and_ignores_the_rest_of_the_payload() {
        let json = r#"{"data":[
          {"id":"25","name":"Kappa","images":{"url_1x":"a"},"emote_type":"globals"},
          {"id":"1902","name":"Keepo","images":{"url_1x":"b"}}
        ],"template":"https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}"}"#;
        let parsed = emotes(serde_json::from_str(json).unwrap());
        assert_eq!(parsed, vec![emote("25", "Kappa"), emote("1902", "Keepo")]);
    }

    #[test]
    fn entries_missing_an_id_or_a_name_are_dropped() {
        let json = r#"{"data":[{"id":"1"},{"name":"orphan"},{"id":"2","name":"LUL"}]}"#;
        assert_eq!(
            emotes(serde_json::from_str(json).unwrap()),
            vec![emote("2", "LUL")]
        );
    }

    #[test]
    fn an_empty_set_is_not_an_error() {
        let json = r#"{"data":[]}"#;
        assert!(emotes(serde_json::from_str::<EmoteResponse>(json).unwrap()).is_empty());
    }
}
