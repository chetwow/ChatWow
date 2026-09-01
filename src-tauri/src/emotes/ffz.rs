//! FrankerFaceZ emotes (v1 API).
//!
//! Global sets: GET https://api.frankerfacez.com/v1/set/global
//! Channel set: GET https://api.frankerfacez.com/v1/room/id/<twitch-user-id>
//!
//! Both answer with a bag of numbered sets, so the work here is picking the
//! ones that apply: the global response lists which of its sets are on by
//! default (the rest are opt-in per user, which we have no account to read),
//! and a room response names the one set belonging to that channel.

use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

use crate::emotes::Emote;

#[derive(Deserialize)]
struct SetsResponse {
    /// Present on the global response: the sets FFZ turns on for everyone.
    #[serde(default)]
    default_sets: Vec<i64>,
    /// Present on a room response, naming that channel's own set.
    #[serde(default)]
    room: Option<Room>,
    #[serde(default)]
    sets: HashMap<String, EmoteSet>,
}

#[derive(Deserialize)]
struct Room {
    #[serde(default)]
    set: Option<i64>,
}

#[derive(Deserialize)]
struct EmoteSet {
    #[serde(default)]
    emoticons: Vec<FfzEmote>,
}

#[derive(Deserialize)]
struct FfzEmote {
    id: i64,
    name: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    /// Scale ("1", "2", "4") to url. FFZ doesn't promise every scale exists.
    #[serde(default)]
    urls: HashMap<String, String>,
    /// The same map again for emotes that move, pointing at webp instead. An
    /// animated emote served from its static url is a still frame, so these
    /// win wherever they exist.
    #[serde(default)]
    animated: HashMap<String, String>,
}

/// FFZ returns protocol-relative urls (`//cdn.frankerfacez.com/...`).
fn absolutize(url: &str) -> String {
    match url {
        _ if url.starts_with("//") => format!("https:{url}"),
        _ if url.starts_with("http") => url.to_string(),
        _ => format!("https://{url}"),
    }
}

/// The best url at or below `scale`, preferring the animated variant. FFZ
/// emotes are commonly uploaded at one size only, so falling back down the
/// scales is the difference between an emote and a blank.
fn pick_url(emote: &FfzEmote, scale: &str) -> Option<String> {
    let order: &[&str] = match scale {
        "4" => &["4", "2", "1"],
        _ => &["2", "1", "4"],
    };
    for candidate in order {
        if let Some(url) = emote.animated.get(*candidate).or_else(|| emote.urls.get(*candidate)) {
            if !url.is_empty() {
                return Some(absolutize(url));
            }
        }
    }
    None
}

fn build_map<'a>(sets: impl Iterator<Item = &'a EmoteSet>) -> HashMap<String, Emote> {
    let mut map = HashMap::new();
    for set in sets {
        for emote in &set.emoticons {
            if emote.name.is_empty() {
                continue;
            }
            let Some(url) = pick_url(emote, "2") else { continue };
            let url_large = pick_url(emote, "4").unwrap_or_else(|| url.clone());

            map.insert(
                emote.name.clone(),
                Emote {
                    id: emote.id.to_string(),
                    name: emote.name.clone(),
                    url,
                    url_large,
                    provider: "ffz",
                    // FFZ modifiers (`z!` and friends) are a prefix syntax
                    // rather than 7TV's zero-width overlays -- nothing here
                    // stacks onto the emote before it.
                    zero_width: false,
                    width: emote.width,
                    height: emote.height,
                },
            );
        }
    }
    map
}

fn global_map(response: &SetsResponse) -> HashMap<String, Emote> {
    // Only the default sets: the others are ones a FFZ user can opt into, and
    // a plain chat client has no account to read that choice from.
    build_map(
        response
            .default_sets
            .iter()
            .filter_map(|id| response.sets.get(&id.to_string())),
    )
}

fn room_map(response: &SetsResponse) -> HashMap<String, Emote> {
    // A room names its set, but fall back to whatever sets came back: FFZ has
    // shipped responses whose `room.set` didn't match the key it was filed
    // under, and one set is one set either way.
    match response.room.as_ref().and_then(|room| room.set) {
        Some(id) => match response.sets.get(&id.to_string()) {
            Some(set) => build_map(std::iter::once(set)),
            None => build_map(response.sets.values()),
        },
        None => build_map(response.sets.values()),
    }
}

pub async fn fetch_global(client: &reqwest::Client) -> Result<HashMap<String, Emote>> {
    let response: SetsResponse = client
        .get("https://api.frankerfacez.com/v1/set/global")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(global_map(&response))
}

/// Channel emotes for a Twitch user id. A channel FFZ doesn't know answers
/// 404 -- no emotes rather than an error, same as the other providers.
pub async fn fetch_channel(
    client: &reqwest::Client,
    twitch_user_id: &str,
) -> Result<HashMap<String, Emote>> {
    let response = client
        .get(format!("https://api.frankerfacez.com/v1/room/id/{twitch_user_id}"))
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(HashMap::new());
    }

    let sets: SetsResponse = response.json().await?;
    Ok(room_map(&sets))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GLOBAL: &str = r#"{
        "default_sets":[3],
        "sets":{
          "3":{"id":3,"emoticons":[
            {"id":28138,"name":"CatBag","width":31,"height":30,
             "urls":{"1":"//cdn.frankerfacez.com/emote/28138/1","2":"//cdn.frankerfacez.com/emote/28138/2","4":"//cdn.frankerfacez.com/emote/28138/4"}}
          ]},
          "4330":{"id":4330,"emoticons":[{"id":1,"name":"OptInOnly","urls":{"1":"//cdn.frankerfacez.com/emote/1/1"}}]}
        }
      }"#;

    #[test]
    fn only_the_default_sets_are_global() {
        let map = global_map(&serde_json::from_str(GLOBAL).unwrap());
        let cat = map.get("CatBag").expect("CatBag present");
        assert_eq!(cat.id, "28138");
        assert_eq!(cat.url, "https://cdn.frankerfacez.com/emote/28138/2");
        assert_eq!(cat.url_large, "https://cdn.frankerfacez.com/emote/28138/4");
        assert_eq!(cat.provider, "ffz");
        assert_eq!(cat.width, 31);
        assert!(
            !map.contains_key("OptInOnly"),
            "a set nobody opted into isn't global"
        );
    }

    #[test]
    fn a_room_takes_the_set_it_names() {
        let json = r#"{
            "room":{"set":12345,"twitch_id":22484632},
            "sets":{"12345":{"id":12345,"emoticons":[
              {"id":7,"name":"forsenE","urls":{"1":"//cdn.frankerfacez.com/emote/7/1"}}]}}
          }"#;
        let map = room_map(&serde_json::from_str(json).unwrap());
        assert_eq!(map["forsenE"].id, "7");
        // Only "1" exists, so both sizes fall back to it rather than 404ing.
        assert_eq!(map["forsenE"].url, "https://cdn.frankerfacez.com/emote/7/1");
        assert_eq!(map["forsenE"].url_large, "https://cdn.frankerfacez.com/emote/7/1");
    }

    #[test]
    fn animated_urls_win_over_the_static_ones() {
        // The static url of an animated emote is a single frame.
        let json = r#"{
            "room":{"set":1},
            "sets":{"1":{"emoticons":[{"id":9,"name":"pokiW",
              "urls":{"2":"//cdn.frankerfacez.com/emote/9/2"},
              "animated":{"2":"//cdn.frankerfacez.com/emote/9/animated/2.webp"}}]}}
          }"#;
        let map = room_map(&serde_json::from_str(json).unwrap());
        assert_eq!(map["pokiW"].url, "https://cdn.frankerfacez.com/emote/9/animated/2.webp");
    }

    #[test]
    fn a_set_the_room_doesnt_name_is_still_read() {
        let json = r#"{"sets":{"77":{"emoticons":[{"id":5,"name":"x","urls":{"2":"//c/2"}}]}}}"#;
        assert!(room_map(&serde_json::from_str(json).unwrap()).contains_key("x"));
    }

    #[test]
    fn emotes_with_no_usable_url_are_skipped() {
        let json = r#"{"sets":{"1":{"emoticons":[{"id":3,"name":"broken","urls":{}}]}}}"#;
        assert!(room_map(&serde_json::from_str(json).unwrap()).is_empty());
    }
}
