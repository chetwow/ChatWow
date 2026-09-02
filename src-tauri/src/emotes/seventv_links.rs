//! Previews for links to a 7TV emote page.
//!
//!   GET https://7tv.io/v3/emotes/<id>
//!
//! The same reasoning as `twitch::links`: 7tv.app is a script-driven site, and
//! what a chatter wants to see when someone pastes an emote link is the emote
//! -- a thing this app already knows how to draw, from an API it already talks
//! to. So the link is answered by the API rather than by scraping the page, and
//! it previews as the emote itself rather than as a card about a web page.
//!
//! Best-effort, like every other resolver behind `link_preview`: an id 7TV
//! doesn't know, an emote with no image, or a call that fails all fall through
//! to the ordinary page preview.

use anyhow::Result;
use reqwest::Url;
use serde::Deserialize;

use crate::linkinfo::LinkPreview;

use super::seventv::{absolutize, pick_file, Host};

/// The hosts that serve the emote page. `old.7tv.app` is still linked in chat
/// years on, and it takes the same path shape.
const HOSTS: [&str; 3] = ["7tv.app", "old.7tv.app", "7tv.io"];

/// The emote id in a 7TV emote link, or `None` for anything else on the site.
///
/// Ids are the site's own object ids -- 26 characters of base32 -- and the
/// check is that they're alphanumeric and roughly that long, since the id goes
/// into a url path. A path with more segments after the id (`/emotes/<id>/x`)
/// is somebody else's page shape and isn't guessed at.
pub fn parse(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if !HOSTS.contains(&host) {
        return None;
    }

    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    // `/v3/emotes/<id>` reaches the same emote as `/emotes/<id>`.
    let mut first = segments.next()?;
    if first.starts_with('v') && first.len() == 2 {
        first = segments.next()?;
    }
    if first != "emotes" {
        return None;
    }
    let id = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    if id.len() < 20 || id.len() > 32 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(id.to_string())
}

#[derive(Deserialize)]
struct EmoteResponse {
    #[serde(default)]
    name: String,
    #[serde(default)]
    animated: bool,
    #[serde(default)]
    owner: Option<Owner>,
    #[serde(default)]
    host: Option<Host>,
}

#[derive(Deserialize)]
struct Owner {
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    username: String,
}

/// The emote as a preview: its name, the big image, and who made it.
///
/// `description` carries the owner rather than a summary, which is what an
/// emote's "summary" amounts to -- the frontend draws this as an emote card
/// (image, name, who by), not as a page card, so there is no thumbnail-and-blurb
/// shape for it to fill. `ttl_seconds` stays zero: an emote's name and owner
/// won't change while you're reading chat.
fn build(emote: EmoteResponse) -> Option<LinkPreview> {
    let host = emote.host?;
    let file = pick_file(&host.files, "4x").or_else(|| pick_file(&host.files, "2x"))?;
    if emote.name.is_empty() {
        return None;
    }

    let owner = emote
        .owner
        .map(|owner| {
            if owner.display_name.is_empty() {
                owner.username
            } else {
                owner.display_name
            }
        })
        .unwrap_or_default();

    Some(LinkPreview {
        title: emote.name,
        description: owner,
        image: absolutize(&host.url, &file.name),
        // Animation is the one thing the still image can't say for itself, and
        // it's the difference between two emotes with the same picture.
        facts: if emote.animated {
            vec![crate::linkinfo::Fact::new("Kind", "Animated")]
        } else {
            Vec::new()
        },
        ttl_seconds: 0,
    })
}

pub async fn preview(client: &reqwest::Client, id: &str) -> Result<Option<LinkPreview>> {
    let response = client.get(format!("https://7tv.io/v3/emotes/{id}")).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(build(response.json::<EmoteResponse>().await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_of(href: &str) -> Option<String> {
        parse(&Url::parse(href).unwrap())
    }

    #[test]
    fn an_emote_link_is_its_id() {
        assert_eq!(
            id_of("https://7tv.app/emotes/01FW4E4Q6R00023D6NVRA4DQMS"),
            Some("01FW4E4Q6R00023D6NVRA4DQMS".to_string())
        );
        assert_eq!(
            id_of("https://old.7tv.app/emotes/01FW4E4Q6R00023D6NVRA4DQMS"),
            Some("01FW4E4Q6R00023D6NVRA4DQMS".to_string())
        );
        assert_eq!(
            id_of("https://7tv.io/v3/emotes/01FW4E4Q6R00023D6NVRA4DQMS"),
            Some("01FW4E4Q6R00023D6NVRA4DQMS".to_string())
        );
    }

    #[test]
    fn a_query_or_fragment_doesnt_change_the_id() {
        assert_eq!(
            id_of("https://7tv.app/emotes/01FW4E4Q6R00023D6NVRA4DQMS?tab=info#top"),
            Some("01FW4E4Q6R00023D6NVRA4DQMS".to_string())
        );
    }

    #[test]
    fn anything_else_on_the_site_is_an_ordinary_link() {
        assert_eq!(id_of("https://7tv.app/users/01FEKBRZE00007WK8WM6W04MSR"), None);
        assert_eq!(id_of("https://7tv.app/emotes"), None);
        assert_eq!(id_of("https://7tv.app/emotes/01FW4E4Q6R00023D6NVRA4DQMS/edit"), None);
        assert_eq!(id_of("https://example.com/emotes/01FW4E4Q6R00023D6NVRA4DQMS"), None);
    }

    #[test]
    fn an_id_that_couldnt_be_one_is_refused_before_it_reaches_a_url() {
        assert_eq!(id_of("https://7tv.app/emotes/short"), None);
        assert_eq!(id_of("https://7tv.app/emotes/01FW4E4Q6R00023D6NVRA4DQM%2F"), None);
    }

    fn parse_preview(json: &str) -> Option<LinkPreview> {
        build(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn an_emote_previews_as_its_name_image_and_owner() {
        let preview = parse_preview(
            r#"{
                "name":"PEPE","animated":false,
                "owner":{"display_name":"SwaguarTV","username":"swaguartv"},
                "host":{"url":"//cdn.7tv.app/emote/abc","files":[
                    {"name":"2x.webp","format":"WEBP","width":64,"height":64},
                    {"name":"4x.webp","format":"WEBP","width":128,"height":128}
                ]}
            }"#,
        )
        .unwrap();
        assert_eq!(preview.title, "PEPE");
        assert_eq!(preview.description, "SwaguarTV");
        assert_eq!(preview.image, "https://cdn.7tv.app/emote/abc/4x.webp");
        assert!(preview.facts.is_empty(), "a still emote says nothing about animation");
    }

    #[test]
    fn an_animated_emote_says_so() {
        let preview = parse_preview(
            r#"{
                "name":"catJAM","animated":true,
                "host":{"url":"//cdn.7tv.app/emote/abc","files":[
                    {"name":"4x.webp","format":"WEBP","width":128,"height":128}
                ]}
            }"#,
        )
        .unwrap();
        assert_eq!(preview.facts[0].value, "Animated");
        assert_eq!(preview.description, "", "nobody named is not somebody named nothing");
    }

    #[test]
    fn an_emote_with_no_image_is_no_preview() {
        assert!(parse_preview(r#"{"name":"PEPE"}"#).is_none());
        assert!(parse_preview(
            r#"{"name":"","host":{"url":"//cdn.7tv.app/emote/abc","files":[
                {"name":"4x.webp","format":"WEBP"}
            ]}}"#
        )
        .is_none());
    }
}
