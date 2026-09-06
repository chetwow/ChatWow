//! Which joined channels are live, for the tab bar's dot.
//!
//! Like channel search, this needs a token -- Helix has no anonymous way to ask
//! and an app token would need the client secret this app never has. Signed
//! out, nothing is reported live rather than reported offline: we don't know,
//! and a confidently wrong "offline" dot is worse than no dot.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Helix caps `user_login` at 100 per request. Nobody has that many tabs, but
/// chunking costs one line and turns a silent 400 into a non-event.
const MAX_LOGINS: usize = 100;

#[derive(Deserialize)]
struct StreamsResponse {
    #[serde(default)]
    data: Vec<Stream>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub title: String,
    pub category: String,
    pub thumbnail_url: String,
}

#[derive(Deserialize)]
struct Stream {
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    user_login: String,
    /// "live" for an actual broadcast; Twitch also uses this for reruns.
    #[serde(default, rename = "type")]
    kind: String,
}

/// The logins that are actually broadcasting. Helix only returns live streams,
/// so absence is what tells us a channel is offline -- but `type` still has to
/// be checked, since a rerun comes back here too and isn't the streamer being
/// on.
fn live_logins(response: StreamsResponse) -> HashMap<String, StreamInfo> {
    response
        .data
        .into_iter()
        .filter(|stream| stream.kind == "live" && !stream.user_login.is_empty())
        .map(|stream| {
            (
                stream.user_login.to_lowercase(),
                StreamInfo {
                    title: stream.title,
                    category: stream.game_name,
                    thumbnail_url: stream
                        .thumbnail_url
                        .replace("{width}", "640")
                        .replace("{height}", "360"),
                },
            )
        })
        .collect()
}

/// Ask about every login in one go, or in chunks of 100 if there are somehow
/// more. A chunk that fails takes the whole call down rather than reporting a
/// partial picture as fact -- the caller keeps the previous answer.
pub async fn fetch_live(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    logins: &[String],
) -> Result<HashMap<String, StreamInfo>> {
    let mut live = HashMap::new();
    for chunk in logins.chunks(MAX_LOGINS) {
        let query: Vec<(&str, &str)> = chunk
            .iter()
            .map(|login| ("user_login", login.as_str()))
            .collect();
        let response = client
            .get("https://api.twitch.tv/helix/streams")
            .query(&query)
            .header("Client-Id", client_id)
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?
            .json::<StreamsResponse>()
            .await?;
        live.extend(live_logins(response));
    }
    Ok(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> HashMap<String, StreamInfo> {
        live_logins(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn collects_the_logins_of_live_streams() {
        let live = parse(
            r#"{"data":[
              {"user_login":"forsen","type":"live"},
              {"user_login":"nymn","type":"live"}
            ]}"#,
        );
        assert_eq!(live.len(), 2);
        assert!(live.contains_key("forsen"));
        assert!(live.contains_key("nymn"));
    }

    #[test]
    fn a_rerun_does_not_count_as_live() {
        // Twitch returns reruns from this endpoint too, but the streamer isn't
        // actually on -- the dot would be a lie.
        let live = parse(r#"{"data":[{"user_login":"forsen","type":"rerun"}]}"#);
        assert!(live.is_empty());
    }

    #[test]
    fn logins_are_lowercased_to_match_the_channel_list() {
        // Channels are stored lowercase; Helix isn't guaranteed to agree.
        let live = parse(r#"{"data":[{"user_login":"Forsen","type":"live"}]}"#);
        assert!(live.contains_key("forsen"));
    }

    #[test]
    fn nobody_live_is_not_an_error() {
        assert!(parse(r#"{"data":[]}"#).is_empty());
        assert!(parse(r#"{}"#).is_empty());
    }

    #[test]
    fn resolves_thumbnail_dimensions_and_mirrors_the_ipc_field() {
        let live = parse(
            r#"{"data":[{"user_login":"forsen","type":"live","thumbnail_url":"https://static-cdn.jtvnw.net/previews-ttv/live_user_forsen-{width}x{height}.jpg"}]}"#,
        );
        assert_eq!(
            live["forsen"].thumbnail_url,
            "https://static-cdn.jtvnw.net/previews-ttv/live_user_forsen-640x360.jpg"
        );
        assert_eq!(
            serde_json::to_value(&live).unwrap()["forsen"]["thumbnailUrl"],
            live["forsen"].thumbnail_url
        );
        assert!(
            parse(r#"{"data":[{"user_login":"forsen","type":"live"}]}"#)["forsen"]
                .thumbnail_url
                .is_empty()
        );
    }

    #[test]
    fn retains_metadata_and_detects_changes_without_a_live_status_change() {
        let first = parse(
            r#"{"data":[{"user_login":"Forsen","type":"live","title":"Hello 世界","game_name":"Minecraft"}]}"#,
        );
        assert_eq!(first["forsen"].title, "Hello 世界");
        assert_eq!(first["forsen"].category, "Minecraft");
        let next = parse(
            r#"{"data":[{"user_login":"forsen","type":"live","title":"New title","game_name":"Just Chatting"}]}"#,
        );
        assert_ne!(first, next);
        assert_eq!(
            serde_json::to_value(&first).unwrap()["forsen"]["category"],
            "Minecraft"
        );
    }
}
