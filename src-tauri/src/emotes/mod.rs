pub mod bttv;
pub mod cache;
pub mod ffz;
pub mod seventv;
pub mod seventv_badges;

use serde::Serialize;
use std::collections::HashMap;

/// A renderable emote from any provider.
#[derive(Debug, Clone, Serialize)]
pub struct Emote {
    /// Provider-assigned id. Stable across renames -- 7TV emotes are commonly
    /// aliased per channel -- so it's what the image cache is keyed on.
    pub id: String,
    pub name: String,
    /// Inline-size image used in the message body.
    pub url: String,
    /// Larger image used in the hover tooltip.
    pub url_large: String,
    pub provider: &'static str,
    /// Overlay emotes stack on top of the preceding emote instead of sitting beside it.
    pub zero_width: bool,
    pub width: u32,
    pub height: u32,
}

/// Twitch's own emotes are addressed by id and need no API call.
pub fn twitch_emote(id: &str, name: &str) -> Emote {
    Emote {
        id: id.to_string(),
        name: name.to_string(),
        url: format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"),
        url_large: format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/3.0"),
        provider: "twitch",
        zero_width: false,
        width: 28,
        height: 28,
    }
}

/// Which third-party emote providers are switched on. A copy rather than a
/// borrow of the preferences: these are read either side of an await, and a
/// `parking_lot` guard can't be held across one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Providers {
    pub seventv: bool,
    pub bttv: bool,
    pub ffz: bool,
}

impl From<&crate::settings::Preferences> for Providers {
    fn from(preferences: &crate::settings::Preferences) -> Self {
        Self {
            seventv: preferences.enable_seventv,
            bttv: preferences.enable_bttv,
            ffz: preferences.enable_ffz,
        }
    }
}

/// Fold the providers' maps into one, in the order they're given: a name in a
/// later map wins. Callers pass them lowest-priority first, which is what
/// decides whose emote a chatter sees when two providers ship the same name --
/// 7TV last, since it's the set most channels actually curate.
pub fn merge(maps: Vec<HashMap<String, Emote>>) -> HashMap<String, Emote> {
    let mut merged: HashMap<String, Emote> = HashMap::new();
    for map in maps {
        merged.extend(map);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emote(provider: &'static str, name: &str) -> Emote {
        Emote {
            id: format!("{provider}-id"),
            name: name.to_string(),
            url: String::new(),
            url_large: String::new(),
            provider,
            zero_width: false,
            width: 28,
            height: 28,
        }
    }

    #[test]
    fn the_last_provider_wins_a_shared_name() {
        let ffz = HashMap::from([("KEKW".to_string(), emote("ffz", "KEKW"))]);
        let bttv = HashMap::from([
            ("KEKW".to_string(), emote("bttv", "KEKW")),
            ("haHAA".to_string(), emote("bttv", "haHAA")),
        ]);
        let seventv = HashMap::from([("KEKW".to_string(), emote("7tv", "KEKW"))]);

        let merged = merge(vec![ffz, bttv, seventv]);
        assert_eq!(merged["KEKW"].provider, "7tv");
        assert_eq!(merged["haHAA"].provider, "bttv", "names only one provider has survive");
    }
}
