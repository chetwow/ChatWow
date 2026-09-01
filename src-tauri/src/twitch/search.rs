//! Channel search via the Helix API, for the join dialog's suggestions.
//!
//! Twitch offers no unauthenticated way to search channels, and an *app* token
//! would need the client secret this app deliberately never has -- so this runs
//! on the signed-in user's token or not at all. Callers check for credentials
//! first; the UI tells you to sign in rather than silently finding nothing.
//!
//! The endpoint covers any channel that has streamed in the past six months,
//! ordered by relevance, so it reaches far past what a bundled list could.

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// How many suggestions to ask for. The dialog shows a short list -- this is a
/// dropdown under an input, not a directory to page through.
const LIMIT: usize = 8;

/// One suggestion, resolved for rendering the way every other payload is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelHit {
    /// The lowercase name to actually join.
    pub login: String,
    /// How the broadcaster capitalizes it, which is what we show.
    pub display_name: String,
    pub is_live: bool,
    /// Empty when offline, or when Twitch has no game for the stream.
    pub game_name: String,
    /// Profile image. Empty if Twitch didn't give us one.
    pub thumbnail_url: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    data: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(default)]
    broadcaster_login: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    is_live: bool,
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    thumbnail_url: String,
}

/// Live channels first, then relevance order as Twitch returned it.
///
/// Someone typing a name into a chat client is usually going somewhere to
/// watch, and a sort is stable, so within each group Twitch's own ranking
/// stands. Hits with no login are dropped -- there'd be nothing to join.
fn build_hits(response: SearchResponse) -> Vec<ChannelHit> {
    let mut hits: Vec<ChannelHit> = response
        .data
        .into_iter()
        .filter(|hit| !hit.broadcaster_login.is_empty())
        .map(|hit| ChannelHit {
            display_name: if hit.display_name.is_empty() {
                hit.broadcaster_login.clone()
            } else {
                hit.display_name
            },
            login: hit.broadcaster_login,
            is_live: hit.is_live,
            game_name: hit.game_name,
            thumbnail_url: hit.thumbnail_url,
        })
        .collect();
    hits.sort_by_key(|hit| !hit.is_live);
    hits
}

pub async fn search_channels(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    query: &str,
) -> Result<Vec<ChannelHit>> {
    let response = client
        .get("https://api.twitch.tv/helix/search/channels")
        .query(&[("query", query), ("first", &LIMIT.to_string())])
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json::<SearchResponse>()
        .await?;
    Ok(build_hits(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Vec<ChannelHit> {
        build_hits(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn keeps_the_display_name_and_the_login_apart() {
        let hits = parse(
            r#"{"data":[{"broadcaster_login":"forsen","display_name":"Forsen",
                "is_live":true,"game_name":"Chess","thumbnail_url":"https://cdn/f.png"}]}"#,
        );
        assert_eq!(hits.len(), 1);
        // The login is what IRC joins; the display name is only ever shown.
        assert_eq!(hits[0].login, "forsen");
        assert_eq!(hits[0].display_name, "Forsen");
        assert!(hits[0].is_live);
        assert_eq!(hits[0].game_name, "Chess");
    }

    #[test]
    fn live_channels_sort_first_and_keep_twitch_order_within_each_group() {
        let hits = parse(
            r#"{"data":[
              {"broadcaster_login":"a","display_name":"A","is_live":false},
              {"broadcaster_login":"b","display_name":"B","is_live":true},
              {"broadcaster_login":"c","display_name":"C","is_live":false},
              {"broadcaster_login":"d","display_name":"D","is_live":true}
            ]}"#,
        );
        let names: Vec<&str> = hits.iter().map(|hit| hit.login.as_str()).collect();
        assert_eq!(names, ["b", "d", "a", "c"]);
    }

    #[test]
    fn a_hit_with_no_login_is_dropped() {
        // Nothing to join, so it can't be offered.
        let hits = parse(r#"{"data":[{"display_name":"Ghost","is_live":true}]}"#);
        assert!(hits.is_empty());
    }

    #[test]
    fn a_missing_display_name_falls_back_to_the_login() {
        let hits = parse(r#"{"data":[{"broadcaster_login":"nymn"}]}"#);
        assert_eq!(hits[0].display_name, "nymn");
    }

    #[test]
    fn absent_optional_fields_are_not_an_error() {
        let hits = parse(r#"{"data":[{"broadcaster_login":"x","display_name":"X"}]}"#);
        assert_eq!(hits[0].game_name, "");
        assert_eq!(hits[0].thumbnail_url, "");
        assert!(!hits[0].is_live);
    }

    #[test]
    fn an_empty_result_set_is_not_an_error() {
        assert!(parse(r#"{"data":[]}"#).is_empty());
        assert!(parse(r#"{}"#).is_empty());
    }
}
