pub mod cache;
pub mod seventv;

use serde::Serialize;

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
