//! Room-owned Cheermote metadata. Helix includes global and channel-custom art
//! in one response; any signed-in account can fetch it without extra scopes.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct Cheermote {
    /// Preserve the original token for copying, replies and failed images.
    pub text: String,
    pub bits: u64,
    pub color: String,
    pub url: String,
    pub url_static: String,
    pub url_large: String,
}

#[derive(Debug, Default)]
pub struct Catalog(HashMap<String, Vec<Tier>>);

#[derive(Debug, Deserialize)]
struct Tier {
    min_bits: u64,
    color: String,
    #[serde(default)]
    images: HashMap<String, HashMap<String, HashMap<String, String>>>,
}

impl Tier {
    fn image(&self, format: &str, large: bool) -> Option<&str> {
        let sizes = if large {
            ["4", "3", "2", "1.5", "1"]
        } else {
            ["2", "3", "4", "1.5", "1"]
        };
        for theme in ["dark", "light"] {
            if let Some(images) = self
                .images
                .get(theme)
                .and_then(|formats| formats.get(format))
            {
                for size in sizes {
                    if let Some(url) = images.get(size).filter(|url| url.starts_with("https://")) {
                        return Some(url);
                    }
                }
            }
        }
        None
    }
}

impl Catalog {
    pub fn resolve(&self, token: &str) -> Option<Cheermote> {
        // Prefixes can contain digits; try the longest matching prefix first.
        let lower = token.to_ascii_lowercase();
        let (prefix, tiers) = self
            .0
            .iter()
            .filter(|(prefix, _)| lower.starts_with(prefix.as_str()) && lower.len() > prefix.len())
            .max_by_key(|(prefix, _)| prefix.len())?;
        let amount = &lower[prefix.len()..];
        if !amount.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let bits = amount.parse::<u64>().ok().filter(|bits| *bits > 0)?;
        let tier = tiers.iter().rev().find(|tier| tier.min_bits <= bits)?;
        let url = tier
            .image("animated", false)
            .or_else(|| tier.image("static", false))?;
        Some(Cheermote {
            text: token.to_string(),
            bits,
            color: crate::color::resolve(Some(&tier.color), prefix),
            url: url.to_string(),
            url_static: tier.image("static", false).unwrap_or(url).to_string(),
            url_large: tier
                .image("animated", true)
                .or_else(|| tier.image("static", true))
                .unwrap_or(url)
                .to_string(),
        })
    }
}

#[derive(Deserialize)]
struct Response {
    data: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    prefix: String,
    #[serde(rename = "type")]
    kind: String,
    tiers: Vec<Tier>,
}

fn catalog(response: Response) -> Catalog {
    let mut map = HashMap::new();
    for mut entry in response.data {
        if entry.kind == "display_only" || entry.prefix.is_empty() || !entry.prefix.is_ascii() {
            continue;
        }
        // can_cheer and show_in_bits_card control purchases, not rendering
        // messages that Twitch has already accepted (including history).
        entry.tiers.sort_by_key(|tier| tier.min_bits);
        map.insert(entry.prefix.to_ascii_lowercase(), entry.tiers);
    }
    Catalog(map)
}

pub async fn fetch(
    http: &reqwest::Client,
    client_id: &str,
    token: &str,
    room_id: &str,
) -> Result<Catalog> {
    let response = http
        .get("https://api.twitch.tv/helix/bits/cheermotes")
        .query(&[("broadcaster_id", room_id)])
        .header("Client-Id", client_id)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json::<Response>()
        .await?;
    Ok(catalog(response))
}

#[cfg(test)]
pub(crate) fn fixture() -> Catalog {
    catalog(serde_json::from_value(serde_json::json!({"data": [
        {"prefix": "Cheer", "type": "global_first_party", "tiers": [
            {"min_bits": 100, "color": "#9c3ee8", "images": {"dark": {
                "animated": {"2": "https://cdn.example/100.gif", "4": "https://cdn.example/100-large.gif"},
                "static": {"2": "https://cdn.example/100.png"}}}},
            {"min_bits": 1, "color": "#979797", "images": {"dark": {
                "animated": {"2": "https://cdn.example/1.gif"}}}}
        ]},
        {"prefix": "Creator2", "type": "channel_custom", "tiers": [
            {"min_bits": 10, "color": "#00ff00", "images": {"light": {
                "static": {"1": "https://cdn.example/custom.png"}}}}
        ]},
        {"prefix": "Internal", "type": "display_only", "tiers": []}
    ]})).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_tiers_case_custom_prefixes_and_static_fallback() {
        let catalog = fixture();
        for (token, image) in [
            ("Cheer1", "1.gif"),
            ("cHeEr99", "1.gif"),
            ("CHEER100", "100.gif"),
            ("Cheer101", "100.gif"),
        ] {
            let cheer = catalog.resolve(token).unwrap();
            assert!(cheer.url.ends_with(image));
            assert_eq!(cheer.text, token);
        }
        let cheer = catalog.resolve("Cheer100").unwrap();
        assert!(cheer.url_static.ends_with("100.png"));
        assert!(cheer.url_large.ends_with("100-large.gif"));
        let custom = catalog.resolve("Creator210").unwrap();
        assert_eq!(custom.bits, 10);
        assert!(custom.url.ends_with("custom.png"));
    }

    #[test]
    fn rejects_invalid_amounts_unknown_prefixes_and_internal_art() {
        let catalog = fixture();
        assert!(!catalog.0.contains_key("internal"));
        for token in [
            "Cheer",
            "Cheer0",
            "Cheer-1",
            "Cheer1.5",
            "Cheer100!",
            "@Cheer100",
            "Other100",
            "Creator29",
            "Cheer18446744073709551616",
        ] {
            assert!(catalog.resolve(token).is_none(), "{token}");
        }
    }
}
