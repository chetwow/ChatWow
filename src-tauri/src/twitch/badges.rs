//! Twitch chat badges via the Helix API.
//!
//! The old public badges.twitch.tv endpoint has been retired, so these calls
//! require a Client-Id and a bearer token. Without auth we degrade gracefully:
//! the maps stay empty and the UI renders badge names as text chips.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Keyed by (set_id, version), e.g. ("subscriber", "12").
pub type BadgeMap = HashMap<(String, String), Badge>;

#[derive(Debug, Clone, Serialize)]
pub struct Badge {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Deserialize)]
struct BadgeResponse {
    #[serde(default)]
    data: Vec<BadgeSet>,
}

#[derive(Deserialize)]
struct BadgeSet {
    set_id: String,
    #[serde(default)]
    versions: Vec<BadgeVersion>,
}

#[derive(Deserialize)]
struct BadgeVersion {
    id: String,
    #[serde(default)]
    image_url_4x: String,
    #[serde(default)]
    image_url_2x: String,
    #[serde(default)]
    title: String,
}

fn build_map(response: BadgeResponse) -> BadgeMap {
    let mut map = HashMap::new();
    for set in response.data {
        for version in set.versions {
            let url = if version.image_url_4x.is_empty() {
                version.image_url_2x
            } else {
                version.image_url_4x
            };
            if url.is_empty() {
                continue;
            }
            let title = if version.title.is_empty() {
                set.set_id.clone()
            } else {
                version.title
            };
            map.insert(
                (set.set_id.clone(), version.id.clone()),
                Badge {
                    id: format!("{}/{}", set.set_id, version.id),
                    title,
                    url,
                },
            );
        }
    }
    map
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
) -> Result<BadgeMap> {
    let response = client
        .get(url)
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json::<BadgeResponse>()
        .await?;
    Ok(build_map(response))
}

pub async fn fetch_global(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
) -> Result<BadgeMap> {
    fetch(
        client,
        "https://api.twitch.tv/helix/chat/badges/global",
        client_id,
        token,
    )
    .await
}

pub async fn fetch_channel(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    broadcaster_id: &str,
) -> Result<BadgeMap> {
    let url = format!("https://api.twitch.tv/helix/chat/badges?broadcaster_id={broadcaster_id}");
    fetch(client, &url, client_id, token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_lookup_keyed_by_set_and_version() {
        let json = r#"{"data":[
          {"set_id":"moderator","versions":[
            {"id":"1","image_url_1x":"a1","image_url_2x":"a2","image_url_4x":"a4","title":"Moderator"}]},
          {"set_id":"subscriber","versions":[
            {"id":"0","image_url_2x":"s2","image_url_4x":"s4","title":"Subscriber"},
            {"id":"12","image_url_2x":"t2","image_url_4x":"t4","title":"1-Year Subscriber"}]}
        ]}"#;
        let map = build_map(serde_json::from_str(json).unwrap());

        assert_eq!(map.len(), 3);
        let m = map.get(&("moderator".into(), "1".into())).unwrap();
        assert_eq!(m.url, "a4");
        assert_eq!(m.title, "Moderator");
        assert_eq!(m.id, "moderator/1");
        assert_eq!(
            map.get(&("subscriber".into(), "12".into())).unwrap().title,
            "1-Year Subscriber"
        );
    }

    #[test]
    fn falls_back_to_2x_when_4x_is_absent() {
        let json = r#"{"data":[{"set_id":"vip","versions":[{"id":"1","image_url_2x":"v2","title":"VIP"}]}]}"#;
        let map = build_map(serde_json::from_str(json).unwrap());
        assert_eq!(map.get(&("vip".into(), "1".into())).unwrap().url, "v2");
    }

    #[test]
    fn versions_without_any_image_are_dropped() {
        let json = r#"{"data":[{"set_id":"ghost","versions":[{"id":"1","title":"Ghost"}]}]}"#;
        assert!(build_map(serde_json::from_str(json).unwrap()).is_empty());
    }
}
