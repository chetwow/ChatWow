//! 7TV emote sets (v3 API).
//!
//! Global set:  GET https://7tv.io/v3/emote-sets/global
//! Channel set: GET https://7tv.io/v3/users/twitch/<twitch-user-id>

use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

use crate::emotes::Emote;

/// 7TV marks overlay emotes two ways: on the set entry (ActiveEmoteFlag::ZeroWidth)
/// and on the emote itself (EmoteFlag::ZeroWidth). Either one counts.
const ACTIVE_FLAG_ZERO_WIDTH: u32 = 1 << 0;
const EMOTE_FLAG_ZERO_WIDTH: u32 = 1 << 8;

#[derive(Deserialize)]
struct EmoteSet {
    /// The set's own id. What the EventAPI subscribes to -- see
    /// `seventv_events` -- which is the only reason it's read at all.
    #[serde(default)]
    id: String,
    #[serde(default)]
    emotes: Vec<SetEntry>,
}

/// One emote as a set lists it: the name it goes by *here*, pointing at the
/// emote itself. The EventAPI hands over the same shape when one is added, so
/// this is also what `emote_from_value` reads.
#[derive(Deserialize)]
struct SetEntry {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    flags: u32,
    #[serde(default)]
    data: Option<EmoteData>,
}

#[derive(Deserialize)]
struct EmoteData {
    #[serde(default)]
    id: String,
    #[serde(default)]
    flags: u32,
    #[serde(default)]
    host: Option<Host>,
}

/// Where an emote's images live. Shared with `seventv_links`, which reads the
/// same shape off the single-emote endpoint.
#[derive(Deserialize)]
pub struct Host {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub files: Vec<HostFile>,
}

#[derive(Deserialize)]
pub struct HostFile {
    pub name: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

#[derive(Deserialize)]
struct UserResponse {
    #[serde(default)]
    emote_set: Option<EmoteSet>,
}

/// A channel's 7TV set: its emotes, and the id to watch it by. A channel with
/// no 7TV account has neither, which is not an error.
#[derive(Debug, Default)]
pub struct ChannelSet {
    /// `None` when there's no set to watch -- no 7TV account here, or the
    /// answer didn't name one.
    pub id: Option<String>,
    pub emotes: HashMap<String, Emote>,
}

/// Pick a webp file by its scale prefix, e.g. "2x". Falls back to any webp.
pub fn pick_file<'a>(files: &'a [HostFile], scale: &str) -> Option<&'a HostFile> {
    files
        .iter()
        .find(|f| f.format.eq_ignore_ascii_case("WEBP") && f.name.starts_with(scale))
        .or_else(|| files.iter().find(|f| f.format.eq_ignore_ascii_case("WEBP")))
}

pub fn absolutize(host_url: &str, file: &str) -> String {
    // 7TV returns protocol-relative URLs like //cdn.7tv.app/emote/<id>
    if host_url.starts_with("//") {
        format!("https:{host_url}/{file}")
    } else if host_url.starts_with("http") {
        format!("{host_url}/{file}")
    } else {
        format!("https://{host_url}/{file}")
    }
}

/// One set entry as a renderable emote, or `None` when it carries no image or
/// nothing stable to key the image cache on.
fn build_entry(entry: SetEntry) -> Option<Emote> {
    let data = entry.data?;
    let host = data.host?;
    let inline = pick_file(&host.files, "2x")?;

    let large = pick_file(&host.files, "4x").unwrap_or(inline);
    let zero_width =
        entry.flags & ACTIVE_FLAG_ZERO_WIDTH != 0 || data.flags & EMOTE_FLAG_ZERO_WIDTH != 0;

    // The set entry and the emote it points at carry the same id, but only
    // the latter is guaranteed present on a channel set's aliased entries.
    let id = if data.id.is_empty() { entry.id } else { data.id };
    if id.is_empty() {
        return None;
    }

    Some(Emote {
        id,
        name: entry.name,
        url: absolutize(&host.url, &inline.name),
        url_large: absolutize(&host.url, &large.name),
        provider: "7tv",
        zero_width,
        width: inline.width,
        height: inline.height,
    })
}

fn build_map(set: EmoteSet) -> HashMap<String, Emote> {
    let mut map = HashMap::with_capacity(set.emotes.len());
    for entry in set.emotes {
        if let Some(emote) = build_entry(entry) {
            map.insert(emote.name.clone(), emote);
        }
    }
    map
}

/// The same, from a set entry the EventAPI sent rather than one we fetched.
/// It's the identical shape either way, which is why an emote added while
/// you're reading renders exactly like one that was there on join.
pub fn emote_from_value(value: &serde_json::Value) -> Option<Emote> {
    build_entry(serde_json::from_value(value.clone()).ok()?)
}

pub async fn fetch_global(client: &reqwest::Client) -> Result<HashMap<String, Emote>> {
    let set: EmoteSet = client
        .get("https://7tv.io/v3/emote-sets/global")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(build_map(set))
}

/// Channel emotes for a Twitch user id. A channel with no 7TV account is not an
/// error -- it simply has no emotes, so we return an empty map.
pub async fn fetch_channel(client: &reqwest::Client, twitch_user_id: &str) -> Result<ChannelSet> {
    let response = client
        .get(format!("https://7tv.io/v3/users/twitch/{twitch_user_id}"))
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(ChannelSet::default());
    }

    let user: UserResponse = response.json().await?;
    Ok(match user.emote_set {
        Some(set) => ChannelSet {
            id: Some(set.id.clone()).filter(|id| !id.is_empty()),
            emotes: build_map(set),
        },
        None => ChannelSet::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutizes_protocol_relative_urls() {
        assert_eq!(
            absolutize("//cdn.7tv.app/emote/abc", "2x.webp"),
            "https://cdn.7tv.app/emote/abc/2x.webp"
        );
    }

    #[test]
    fn parses_a_set_and_flags_zero_width_emotes() {
        let json = r#"{
            "emotes": [
              {"id":"a","name":"catJAM","flags":0,"data":{"id":"a","flags":0,"host":{"url":"//cdn.7tv.app/emote/a","files":[
                {"name":"1x.webp","format":"WEBP","width":32,"height":32},
                {"name":"2x.webp","format":"WEBP","width":64,"height":64},
                {"name":"4x.webp","format":"WEBP","width":128,"height":128}]}}},
              {"id":"set-entry","name":"RainTime","flags":1,"data":{"id":"b","flags":256,"host":{"url":"//cdn.7tv.app/emote/b","files":[
                {"name":"2x.webp","format":"WEBP","width":64,"height":64}]}}}
            ]
        }"#;
        let set: EmoteSet = serde_json::from_str(json).unwrap();
        let map = build_map(set);

        let cat = map.get("catJAM").expect("catJAM present");
        assert_eq!(cat.id, "a");
        assert_eq!(cat.url, "https://cdn.7tv.app/emote/a/2x.webp");
        assert_eq!(cat.url_large, "https://cdn.7tv.app/emote/a/4x.webp");
        assert!(!cat.zero_width);

        let rain = map.get("RainTime").unwrap();
        assert!(rain.zero_width, "overlay emote must be zero-width");
        assert_eq!(rain.id, "b", "the emote's own id wins over the set entry's");
    }

    #[test]
    fn entries_with_no_id_are_skipped() {
        // Nothing to key the image cache on, and an aliased name isn't stable.
        let set: EmoteSet = serde_json::from_str(
            r#"{"emotes":[{"name":"anon","flags":0,"data":{"flags":0,"host":{"url":"//x","files":[
              {"name":"2x.webp","format":"WEBP","width":64,"height":64}]}}}]}"#,
        )
        .unwrap();
        assert!(build_map(set).is_empty());
    }

    #[test]
    fn entries_without_usable_files_are_skipped() {
        let set: EmoteSet = serde_json::from_str(
            r#"{"emotes":[{"id":"c","name":"broken","flags":0,"data":{"id":"c","flags":0,"host":{"url":"//x","files":[]}}}]}"#,
        )
        .unwrap();
        assert!(build_map(set).is_empty());
    }
}
