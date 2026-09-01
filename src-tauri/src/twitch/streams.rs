//! Which joined channels are live, for the tab bar's dot.
//!
//! Like channel search, this needs a token -- Helix has no anonymous way to ask
//! and an app token would need the client secret this app never has. Signed
//! out, nothing is reported live rather than reported offline: we don't know,
//! and a confidently wrong "offline" dot is worse than no dot.

use anyhow::Result;
use serde::Deserialize;
use std::collections::HashSet;

/// Helix caps `user_login` at 100 per request. Nobody has that many tabs, but
/// chunking costs one line and turns a silent 400 into a non-event.
const MAX_LOGINS: usize = 100;

#[derive(Deserialize)]
struct StreamsResponse {
    #[serde(default)]
    data: Vec<Stream>,
}

#[derive(Deserialize)]
struct Stream {
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
fn live_logins(response: StreamsResponse) -> HashSet<String> {
    response
        .data
        .into_iter()
        .filter(|stream| stream.kind == "live" && !stream.user_login.is_empty())
        .map(|stream| stream.user_login.to_lowercase())
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
) -> Result<HashSet<String>> {
    let mut live = HashSet::new();
    for chunk in logins.chunks(MAX_LOGINS) {
        let query: Vec<(&str, &str)> =
            chunk.iter().map(|login| ("user_login", login.as_str())).collect();
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

    fn parse(json: &str) -> HashSet<String> {
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
        assert!(live.contains("forsen"));
        assert!(live.contains("nymn"));
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
        assert!(live.contains("forsen"));
    }

    #[test]
    fn nobody_live_is_not_an_error() {
        assert!(parse(r#"{"data":[]}"#).is_empty());
        assert!(parse(r#"{}"#).is_empty());
    }
}
