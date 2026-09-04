//! BetterTTV emotes.
//!
//! Global set:  GET https://api.betterttv.net/3/cached/emotes/global
//! Channel set: GET https://api.betterttv.net/3/cached/users/twitch/<twitch-user-id>
//!
//! Images are addressed by id at a fixed set of scales, and BTTV serves the
//! emote's own format (png, gif or webp) from the same url -- so unlike 7TV
//! there's no file list to pick through.

use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

use crate::emotes::Emote;

/// The nominal edge of the `2x` image. BTTV reports no dimensions, and nothing
/// downstream measures the real ones -- this only has to be honest about the
/// scale we ask for.
const INLINE_SIZE: u32 = 56;

#[derive(Deserialize)]
struct BttvEmote {
    id: String,
    code: String,
}

/// A channel's own emotes and the ones it borrows from other channels. Twitch
/// users with no BetterTTV account 404 here, which is not an error -- see
/// `fetch_channel`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelResponse {
    #[serde(default)]
    channel_emotes: Vec<BttvEmote>,
    #[serde(default)]
    shared_emotes: Vec<BttvEmote>,
}

fn image_url(id: &str, scale: &str) -> String {
    format!("https://cdn.betterttv.net/emote/{id}/{scale}")
}

fn build_map(emotes: Vec<BttvEmote>) -> HashMap<String, Emote> {
    let mut map = HashMap::with_capacity(emotes.len());
    for emote in emotes {
        if emote.id.is_empty() || emote.code.is_empty() {
            continue;
        }
        map.insert(
            emote.code.clone(),
            Emote {
                url: image_url(&emote.id, "2x"),
                url_large: image_url(&emote.id, "3x"),
                id: emote.id,
                name: emote.code,
                provider: "bttv",
                // BTTV's "modifier" emotes are a prefix syntax (`w!`, `h!`)
                // rather than 7TV's zero-width overlays, so nothing here
                // stacks onto the emote before it.
                zero_width: false,
                width: INLINE_SIZE,
                height: INLINE_SIZE,
            },
        );
    }
    map
}

pub async fn fetch_global(client: &reqwest::Client) -> Result<HashMap<String, Emote>> {
    let emotes: Vec<BttvEmote> = client
        .get("https://api.betterttv.net/3/cached/emotes/global")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(build_map(emotes))
}

/// Channel emotes for a Twitch user id. A channel with no BetterTTV account
/// answers 404 -- it simply has no emotes, so we return an empty map rather
/// than an error that would be logged on every join.
pub async fn fetch_channel(
    client: &reqwest::Client,
    twitch_user_id: &str,
) -> Result<HashMap<String, Emote>> {
    let response = client
        .get(format!(
            "https://api.betterttv.net/3/cached/users/twitch/{twitch_user_id}"
        ))
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(HashMap::new());
    }

    let user: ChannelResponse = response.json().await?;
    let mut emotes = user.channel_emotes;
    emotes.extend(user.shared_emotes);
    Ok(build_map(emotes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_global_shape() {
        let json = r#"[
            {"id":"54fa8f1401e468494b85b537","code":":tf:","imageType":"png","animated":false},
            {"id":"5590b223b344e2c42a9e28e3","code":"haHAA","imageType":"png","animated":false}
        ]"#;
        let map = build_map(serde_json::from_str(json).unwrap());

        let tf = map.get(":tf:").expect(":tf: present");
        assert_eq!(tf.id, "54fa8f1401e468494b85b537");
        assert_eq!(
            tf.url,
            "https://cdn.betterttv.net/emote/54fa8f1401e468494b85b537/2x"
        );
        assert_eq!(
            tf.url_large,
            "https://cdn.betterttv.net/emote/54fa8f1401e468494b85b537/3x"
        );
        assert_eq!(tf.provider, "bttv");
        assert!(!tf.zero_width);
        assert!(map.contains_key("haHAA"));
    }

    #[test]
    fn a_channels_own_and_borrowed_emotes_both_count() {
        // sharedEmotes carry a `user` object channelEmotes don't -- both are
        // usable in the channel, so both land in the same map.
        let json = r#"{
            "id":"5809977263c97c037fc9e66c",
            "channelEmotes":[{"id":"aaa","code":"forsenE","imageType":"png"}],
            "sharedEmotes":[{"id":"bbb","code":"KEKW","imageType":"webp","user":{"name":"x"}}]
        }"#;
        let user: ChannelResponse = serde_json::from_str(json).unwrap();
        let mut emotes = user.channel_emotes;
        emotes.extend(user.shared_emotes);
        let map = build_map(emotes);

        assert_eq!(map.len(), 2);
        assert_eq!(map["KEKW"].id, "bbb");
    }

    #[test]
    fn entries_missing_an_id_or_a_name_are_skipped() {
        // Nothing to key the image cache on, or nothing to match in a message.
        let json = r#"[{"id":"","code":"nameless"},{"id":"ccc","code":""}]"#;
        assert!(build_map(serde_json::from_str(json).unwrap()).is_empty());
    }
}
