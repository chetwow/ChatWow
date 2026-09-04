//! What's behind a link, for the hover preview.
//!
//! A link that points straight at an image is fetched here and returned as
//! bounded data for a local blob URL. Every other link has to be *asked* what
//! it is: one GET, and the page's own description of itself out of the head.
//!
//! What comes back is what a page already publishes for exactly this purpose --
//! OpenGraph and friends, the same tags that make a link unfurl in Slack or
//! Discord: a title, a sentence, a thumbnail. YouTube gets a little more (see
//! `youtube_facts`), because a bare "Hold Me Now" is a poor showing next to
//! what the page will actually tell you.
//!
//! Three things make this different from every other fetch in the app, and
//! they're why it's a module rather than four lines in a command:
//!
//! * **The url comes from a stranger.** Everything else here talks to Twitch,
//!   7TV, FFZ, BTTV or ivr.fi -- hosts compiled in. This one resolves every hop
//!   itself, refuses any non-public answer, and pins the request to the checked
//!   addresses. That includes preview images: the webview never fetches a
//!   chatter-selected host directly.
//! * **The response is arbitrary too.** A url ending in `/page` can serve a
//!   gigabyte. The body is read in chunks, abandoned at a cap, and stopped the
//!   moment it holds what's wanted -- for most of the web that's the few KB up
//!   to `</head>`.
//! * **It happens on hover.** That's a request to a host of someone else's
//!   choosing, from the user's own address, without a click -- which is the
//!   whole reason these are settings at all, and defaults are the only thing
//!   this module doesn't decide.
//!
use base64::Engine;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use anyhow::Result;
use reqwest::{Response, Url};
use serde::Serialize;

/// Enough of an ordinary page to reach `</head>` several times over. Sites put
/// their metadata in the first few KB; this is the ceiling for the ones that
/// don't, so a hover can't turn into a download.
const MAX_HEAD_BYTES: usize = 256 * 1024;
/// YouTube buries the head under ~700KB of inline script, and the numbers
/// under a little more. It compresses to about a fifth of that on the wire,
/// which is what makes reading this far defensible at all.
const MAX_PAGE_BYTES: usize = 1024 * 1024;
/// Large enough for ordinary chat images without letting a hover pull an
/// unbounded file through IPC and into a blob in the webview.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Long enough for a slow page, short enough that a hover isn't a hang.
const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_REDIRECTS: usize = 5;
/// Past this a "title" is a sentence someone stuffed with keywords.
const MAX_TITLE: usize = 160;
/// The description is the tooltip's second paragraph, not its subject.
const MAX_DESCRIPTION: usize = 320;

/// What the hover preview draws for a link that isn't an image.
///
/// Everything here is already resolved and already formatted: a duration is
/// `4:46`, a view count is `1.2M`, a date is `3 Mar 2023`. The frontend puts
/// the rows on screen and does no arithmetic, which is the same split the rest
/// of the app uses -- `render.rs` hands over image urls, not emote ids.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub title: String,
    /// The page's own summary of itself. Empty when it publishes none.
    pub description: String,
    /// Thumbnail url, empty when the page offers none. A *different* host from
    /// the link often enough (a CDN) that the frontend can't assume otherwise.
    pub image: String,
    /// Labelled rows under the title, in the order they should be drawn. Empty
    /// for a page that's just a page; YouTube and Twitch fill it in.
    pub facts: Vec<Fact>,
    /// How long this answer is worth keeping, in seconds. Zero means forever,
    /// which is the truth for a page: its title won't change while you read
    /// chat. A live stream's viewer count and uptime are wrong within minutes,
    /// so that preview carries its own shelf life rather than the cache in
    /// front of it having to guess which answers rot.
    pub ttl_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub label: String,
    pub value: String,
}

/// A validated preview image. Base64 is compact enough for the bounded IPC
/// response, and the frontend immediately turns it into a local blob URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImage {
    pub mime_type: String,
    pub data: String,
}

impl Fact {
    pub fn new(label: &str, value: impl Into<String>) -> Self {
        Fact {
            label: label.to_string(),
            value: value.into(),
        }
    }
}

fn is_public_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().map(is_public_host).unwrap_or(false)
}

/// Resolve a host once, reject the whole answer if any address belongs to the
/// local machine/network, and return exactly the addresses the request may use.
async fn public_addresses(url: &Url) -> Result<Option<(String, Vec<SocketAddr>)>> {
    if !is_public_url(url) {
        return Ok(None);
    }
    let Some(host) = url.host_str() else {
        return Ok(None);
    };
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await?.collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Ok(None);
    }
    Ok(Some((host.to_string(), addresses)))
}

/// One safe HTTP GET, following redirects by hand so every hop gets a fresh
/// DNS check and the connection is pinned to the addresses that passed it.
async fn fetch(url: Url, accept: &str) -> Result<Option<(Response, Url)>> {
    let mut current = url;
    for redirects in 0..=MAX_REDIRECTS {
        let Some((host, addresses)) = public_addresses(&current).await? else {
            return Ok(None);
        };
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; chatwow link preview)")
            .timeout(TIMEOUT)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addresses)
            .build()?;
        let response = client
            .get(current.clone())
            .header("Accept", accept)
            .send()
            .await?;
        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Ok(None);
            }
            let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
            else {
                return Ok(None);
            };
            current = current.join(location)?;
            continue;
        }
        return Ok(Some((response, current)));
    }
    Ok(None)
}

/// Whether this host is somewhere on the internet, rather than this machine or
/// the network it sits on.
fn is_public_host(host: &str) -> bool {
    // `host_str` keeps the brackets on an IPv6 literal.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return is_public_ip(ip);
    }
    let lower = bare.to_ascii_lowercase();
    !(lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal"))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 0.0.0.0/8, and the carrier-grade NAT range, neither of which
                // has an `is_` of its own on stable.
                || a == 0
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                // Unique local (fc00::/7) and link local (fe80::/10).
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// What the page behind a link says about itself, or `None` when there's
/// nothing to show -- no metadata, not HTML, a refusal, a redirect we wouldn't
/// follow. All of those are the same thing to the caller: draw nothing.
///
/// `Err` is reserved for the request failing outright, which is worth a line
/// in the log even though the preview handles it identically.
pub async fn preview(link: &str) -> Result<Option<LinkPreview>> {
    let url = Url::parse(link)?;
    let video = youtube_id(&url);

    let Some((html, final_url)) = fetch_html(url, video.is_some()).await? else {
        return Ok(None);
    };
    let mut preview = match build_preview(&html, video.is_some()) {
        Some(preview) => preview,
        None => return Ok(None),
    };
    if !preview.image.is_empty() {
        preview.image = final_url
            .join(&preview.image)
            .map(|image| image.to_string())
            .unwrap_or_default();
    }
    Ok(Some(preview))
}

/// Fetch an image through the same public-address gate used for HTML. The
/// caller receives data rather than a remote URL, so the webview cannot issue
/// a second, unchecked request while decoding it.
pub async fn preview_image(link: &str) -> Result<Option<PreviewImage>> {
    let url = Url::parse(link)?;
    let Some((mut response, _)) = fetch(url, "image/*").await? else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime_type.starts_with("image/") {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES as u64)
    {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(PreviewImage {
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(body),
    }))
}

/// Split from `preview` so the parsing is testable without a socket.
fn build_preview(html: &str, youtube: bool) -> Option<LinkPreview> {
    let meta = meta_tags(html);
    let pick = |keys: &[&str]| -> String {
        keys.iter()
            .find_map(|key| meta.get(*key))
            .cloned()
            .unwrap_or_default()
    };

    // OpenGraph first, then Twitter's copy of it, then the plain tags. A page
    // that publishes og: means it for exactly this.
    let title = match pick(&["og:title", "twitter:title", "title"]) {
        empty if empty.is_empty() => title_tag(html).unwrap_or_default(),
        found => found,
    };
    let preview = LinkPreview {
        title: truncate(&title, MAX_TITLE),
        description: truncate(
            &pick(&["og:description", "twitter:description", "description"]),
            MAX_DESCRIPTION,
        ),
        image: pick(&["og:image", "twitter:image", "og:image:url"]),
        facts: if youtube {
            youtube_facts(html, &meta)
        } else {
            Vec::new()
        },
        // Nothing a page publishes about itself goes stale on the timescale of
        // a chat session.
        ttl_seconds: 0,
    };

    // A title is the one thing a preview can't do without: the rest is detail
    // hung off it, and a frame holding only a thumbnail says nothing.
    (!preview.title.is_empty()).then_some(preview)
}

/// The body of an HTML response, up to the point there's no reason to read on.
/// `None` when it isn't a page at all.
async fn fetch_html(url: Url, youtube: bool) -> Result<Option<(String, Url)>> {
    let Some((mut response, final_url)) = fetch(url, "text/html,application/xhtml+xml").await?
    else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    // An absent Content-Type is given the benefit of the doubt; a stated one
    // that isn't HTML is taken at its word, so a video link isn't downloaded
    // in 128KB bites to find no title in it.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.contains("html") {
        return Ok(None);
    }

    let cap = if youtube {
        MAX_PAGE_BYTES
    } else {
        MAX_HEAD_BYTES
    };
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() >= cap || has_enough(&body, youtube) {
            break;
        }
    }
    Ok(Some((
        String::from_utf8_lossy(&body).into_owned(),
        final_url,
    )))
}

/// Whether to stop reading. An ordinary page is done at `</head>`; YouTube's
/// numbers live in the script that follows it, so that one reads until the
/// last of them has turned up.
fn has_enough(body: &[u8], youtube: bool) -> bool {
    let wanted: &[&[u8]] = if youtube {
        &[b"\"viewCount\"", b"\"likeCount\"", b"\"ownerChannelName\""]
    } else {
        &[b"</head>"]
    };
    wanted.iter().all(|needle| contains(body, needle))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

/// Every `<meta>` in the document, keyed by whichever of `property`, `name` or
/// `itemprop` it carries, with the first of each winning -- `og:image` is
/// repeated by pages that offer several, and the first is the one they mean.
///
/// Deliberately not a parser. Titles and meta tags are the two things that can
/// be found this way without meeting anything that would fool it, and a real
/// HTML parse is a dependency and a great deal of work for two fields.
fn meta_tags(html: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    let lower = html.to_ascii_lowercase();
    let mut at = 0;

    while let Some(found) = lower[at..].find("<meta") {
        let start = at + found;
        let Some(len) = lower[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + len];
        at = start + len;

        let key = ["property", "name", "itemprop"]
            .iter()
            .find_map(|attribute| attribute_value(tag, attribute));
        let (Some(key), Some(content)) = (key, attribute_value(tag, "content")) else {
            continue;
        };
        let content = collapse(&decode_entities(&content));
        if content.is_empty() {
            continue;
        }
        tags.entry(key.to_ascii_lowercase()).or_insert(content);
    }
    tags
}

/// The value of one attribute of one tag, quoted either way.
fn attribute_value(tag: &str, attribute: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut at = 0;
    while let Some(found) = lower[at..].find(attribute) {
        let start = at + found;
        at = start + attribute.len();
        // `name` must not match the `name` inside `itemprop`, and `content`
        // must not match `content-type`: the character before has to be a
        // separator, and the one after has to lead to `=`.
        let before_ok = start == 0
            || !lower[..start]
                .chars()
                .next_back()
                .map(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                .unwrap_or(false);
        let rest = lower[at..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }

        let value = tag[at..].trim_start().trim_start_matches('=').trim_start();
        let quote = value.chars().next()?;
        let (open, close) = if quote == '"' || quote == '\'' {
            (1, value[1..].find(quote)? + 1)
        } else {
            (
                0,
                value
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .unwrap_or(value.len()),
            )
        };
        return Some(value[open..close].to_string());
    }
    None
}

/// The text of the first `<title>` element, tidied into one line.
///
/// The lowercase copy is byte-for-byte as long as the original (ASCII case
/// folding leaves every other byte alone), so indices found in one slice the
/// other.
fn title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open = start + lower[start..].find('>')? + 1;
    let close = open + lower[open..].find("</title>")?;

    let text = collapse(&decode_entities(&html[open..close]));
    (!text.is_empty()).then_some(text)
}

/// Titles and descriptions are written across several indented lines often
/// enough that this is the difference between a line and a paragraph.
fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit - 1).collect();
    out.push('\u{2026}');
    out
}

/// The handful of entities that actually turn up in titles, plus numeric ones.
/// Anything else is left as it was typed, which reads better than a blank.
fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        // A `;` far away isn't ending an entity, it's the next clause.
        match after.find(';').filter(|semi| *semi <= 10) {
            Some(semi) => {
                let name = &after[..semi];
                match decode_entity(name) {
                    Some(decoded) => out.push_str(&decoded),
                    None => {
                        out.push('&');
                        out.push_str(name);
                        out.push(';');
                    }
                }
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(name: &str) -> Option<String> {
    let decoded = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        // The typographic ones, which is most of what a real title contains:
        // publishers write dashes and curly quotes, not ampersands.
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "middot" => '\u{00B7}',
        "bull" => '\u{2022}',
        "copy" => '\u{00A9}',
        "reg" => '\u{00AE}',
        "trade" => '\u{2122}',
        "deg" => '\u{00B0}',
        other => {
            let digits = other.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some(decoded.to_string())
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/// The video id in a YouTube url, if that's what this is.
///
/// Everything else on the site (a channel, the front page, a search) is an
/// ordinary page and previews as one -- it's the video that has a card's worth
/// of things to say.
fn youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let path = url.path().trim_matches('/').to_string();

    let id = match host {
        "youtu.be" => path,
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            match path.split_once('/') {
                // `/shorts/<id>`, `/embed/<id>`, `/live/<id>`.
                Some(("shorts" | "embed" | "live" | "v", rest)) => {
                    rest.split('/').next().unwrap_or_default().to_string()
                }
                _ if path == "watch" => url
                    .query_pairs()
                    .find(|(key, _)| key == "v")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default(),
                _ => String::new(),
            }
        }
        _ => String::new(),
    };

    // Ids are 11 characters of the URL-safe alphabet. Checked because it's
    // what decides whether the fetch reads a megabyte looking for numbers.
    (id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(id)
}

/// The rows under a YouTube title: who posted it, how long it is, when it
/// landed, and how it's done since.
///
/// Two sources, both in the page already. The duration is published as
/// schema.org microdata in the head; the counts are in the player's own JSON
/// below it, which is read by looking for the field rather than parsing a
/// megabyte of script into a value. A field that isn't there is a row that
/// isn't drawn -- an unlisted video has no view count worth showing, and a
/// channel that hides likes hides them here too.
fn youtube_facts(html: &str, meta: &HashMap<String, String>) -> Vec<Fact> {
    // `meta_tags` lowercases its keys -- HTML attribute names aren't
    // case-sensitive, and YouTube writes `datePublished`.
    let mut facts = Vec::new();

    if let Some(channel) =
        json_string(html, "ownerChannelName").or_else(|| meta.get("author").cloned())
    {
        facts.push(Fact::new("Channel", channel));
    }
    let seconds = meta
        .get("duration")
        .and_then(|iso| parse_iso_duration(iso))
        .or_else(|| json_string(html, "lengthSeconds").and_then(|s| s.parse().ok()));
    if let Some(seconds) = seconds.filter(|seconds| *seconds > 0) {
        facts.push(Fact::new("Duration", format_duration(seconds)));
    }
    let published = meta
        .get("datepublished")
        .cloned()
        .or_else(|| json_string(html, "publishDate"));
    if let Some(date) = published.as_deref().and_then(format_date) {
        facts.push(Fact::new("Published", date));
    }
    if let Some(views) = json_number(html, "viewCount") {
        facts.push(Fact::new("Views", compact(views)));
    }
    if let Some(likes) = json_number(html, "likeCount") {
        facts.push(Fact::new("Likes", separated(likes)));
    }
    facts
}

/// The value of `"field":"..."` in the page's inline JSON. First occurrence:
/// these fields appear once in the player response and again in copies of it,
/// and the copies say the same thing.
fn json_string(html: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\":\"");
    let start = html.find(&needle)? + needle.len();
    let rest = &html[start..];
    // JSON escapes, minimally: a `\"` isn't the end of the value.
    let mut end = 0;
    let bytes = rest.as_bytes();
    while end < bytes.len() {
        match bytes[end] {
            b'\\' => end += 2,
            b'"' => break,
            _ => end += 1,
        }
    }
    let value = rest.get(..end)?.replace("\\\"", "\"").replace("\\/", "/");
    (!value.is_empty()).then_some(collapse(&value))
}

/// The same, for a count -- which YouTube writes as a quoted string in some
/// places and a bare number in others.
fn json_number(html: &str, field: &str) -> Option<u64> {
    if let Some(text) = json_string(html, field) {
        if let Ok(number) = text.parse() {
            return Some(number);
        }
    }
    let needle = format!("\"{field}\":");
    let start = html.find(&needle)? + needle.len();
    let digits: String = html[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// `PT4M46S` -> 286. Only the shapes YouTube emits: hours, minutes, seconds.
fn parse_iso_duration(iso: &str) -> Option<u64> {
    let rest = iso.strip_prefix("PT")?;
    let mut total = 0u64;
    let mut digits = String::new();
    for c in rest.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let value: u64 = digits.parse().ok()?;
        digits.clear();
        total += match c {
            'H' => value * 3600,
            'M' => value * 60,
            'S' => value,
            _ => return None,
        };
    }
    (total > 0).then_some(total)
}

/// `4:46`, or `1:02:33` once there are hours.
pub fn format_duration(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, (seconds / 60) % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `2023-03-03T04:14:46-08:00` -> `3 Mar 2023`. Only the date part is read:
/// the time a video went up is never what you're hovering to find out, and the
/// zone it's in is the uploader's, not yours.
pub fn format_date(iso: &str) -> Option<String> {
    let date = iso.get(..10)?;
    let mut parts = date.split('-');
    let year: u32 = parts.next()?.parse().ok()?;
    let month: usize = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let name = MONTHS.get(month.checked_sub(1)?)?;
    Some(format!("{day} {name} {year}"))
}

/// `1.2M`, `532K`, `847`. Same shape YouTube itself uses, and the reason the
/// exact number isn't worth the width: nobody hovers a link to learn that a
/// video has 1,215,370 views rather than 1.2 million.
pub fn compact(count: u64) -> String {
    let (scaled, suffix) = match count {
        0..=999 => return count.to_string(),
        1_000..=999_999 => (count as f64 / 1_000.0, "K"),
        1_000_000..=999_999_999 => (count as f64 / 1_000_000.0, "M"),
        _ => (count as f64 / 1_000_000_000.0, "B"),
    };
    if scaled < 10.0 {
        format!("{scaled:.1}{suffix}")
    } else {
        format!("{}{suffix}", scaled.round() as u64)
    }
}

/// `17,430`. Likes are shown in full: they're the number a chatter is usually
/// pointing at, and they're small enough to read.
fn separated(count: u64) -> String {
    let digits = count.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><head>
        <title>Fallback &amp; ignored</title>
        <meta charset="utf-8">
        <meta name="description" content="The plain one">
        <meta property="og:title" content="A Real Title">
        <meta property="og:description" content="What the
             page says about itself &mdash; over two lines">
        <meta property="og:image" content="https://cdn.example.com/card.png">
        <meta property="og:image" content="https://cdn.example.com/second.png">
        </head><body>...</body></html>"#;

    #[test]
    fn opengraph_wins_over_the_title_tag() {
        let preview = build_preview(PAGE, false).expect("a preview");
        assert_eq!(preview.title, "A Real Title");
        assert_eq!(
            preview.description,
            "What the page says about itself \u{2014} over two lines"
        );
        assert_eq!(preview.image, "https://cdn.example.com/card.png");
        assert!(preview.facts.is_empty());
    }

    #[test]
    fn a_page_with_only_a_title_tag_still_previews() {
        let preview =
            build_preview("<html><head><TITLE>Hello</TITLE></head>", false).expect("a preview");
        assert_eq!(preview.title, "Hello");
        assert_eq!(preview.description, "");
        assert_eq!(preview.image, "");
    }

    #[test]
    fn a_page_that_says_nothing_about_itself_has_no_preview() {
        assert_eq!(build_preview("<html><body>hi</body></html>", false), None);
        assert_eq!(build_preview("<title>   </title>", false), None);
    }

    #[test]
    fn attributes_are_read_whole_rather_than_by_substring() {
        let html = r#"<meta http-equiv="content-type" content="text/html">
                      <meta itemprop="name" content="By itemprop">"#;
        let tags = meta_tags(html);
        assert_eq!(tags.get("name").map(String::as_str), Some("By itemprop"));
        // `content-type` is not `content`, and `http-equiv` is not a key we use.
        assert_eq!(tags.get("content-type"), None);
    }

    #[test]
    fn single_quoted_attributes_are_read_too() {
        let tags = meta_tags("<meta property='og:title' content='Quoted'>");
        assert_eq!(tags.get("og:title").map(String::as_str), Some("Quoted"));
    }

    #[test]
    fn a_stray_ampersand_survives_decoding() {
        assert_eq!(decode_entities("rock & roll"), "rock & roll");
        assert_eq!(decode_entities("a &notanentity; b"), "a &notanentity; b");
    }

    #[test]
    fn a_long_title_is_cut_with_an_ellipsis() {
        let long = "a".repeat(MAX_TITLE + 40);
        let cut = truncate(&long, MAX_TITLE);
        assert_eq!(cut.chars().count(), MAX_TITLE);
        assert!(cut.ends_with('\u{2026}'));
    }

    #[test]
    fn truncation_lands_on_a_character_boundary() {
        let long = "\u{1F600}".repeat(MAX_TITLE + 5);
        assert_eq!(truncate(&long, MAX_TITLE).chars().count(), MAX_TITLE);
    }

    #[test]
    fn youtube_urls_are_recognized_in_every_shape() {
        let id = |link: &str| youtube_id(&Url::parse(link).unwrap());
        assert_eq!(
            id("https://youtu.be/qMpBobAonKs"),
            Some("qMpBobAonKs".into())
        );
        assert_eq!(
            id("https://www.youtube.com/watch?v=qMpBobAonKs&t=42"),
            Some("qMpBobAonKs".into())
        );
        assert_eq!(
            id("https://m.youtube.com/shorts/qMpBobAonKs"),
            Some("qMpBobAonKs".into())
        );
        // A channel or the front page is an ordinary page, and a malformed id
        // isn't worth reading a megabyte for.
        assert_eq!(id("https://www.youtube.com/@someone"), None);
        assert_eq!(id("https://www.youtube.com/watch?v=short"), None);
        assert_eq!(id("https://example.com/watch?v=qMpBobAonKs"), None);
    }

    #[test]
    fn youtube_facts_come_off_the_page_in_order() {
        let html = r#"<html><head>
            <meta property="og:title" content="Hold Me Now">
            <meta itemprop="duration" content="PT4M46S">
            <meta itemprop="datePublished" content="2023-03-03T04:14:46-08:00">
            </head><body><script>
            var x = {"ownerChannelName":"Thompson Twins - Topic",
                     "viewCount":"1215370","likeCount":"17430"};
            </script></body></html>"#;
        let preview = build_preview(html, true).expect("a preview");
        let rows: Vec<(&str, &str)> = preview
            .facts
            .iter()
            .map(|fact| (fact.label.as_str(), fact.value.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Channel", "Thompson Twins - Topic"),
                ("Duration", "4:46"),
                ("Published", "3 Mar 2023"),
                ("Views", "1.2M"),
                ("Likes", "17,430"),
            ]
        );
    }

    #[test]
    fn a_missing_number_is_a_row_that_isnt_drawn() {
        let html = r#"<meta property="og:title" content="Unlisted">"#;
        let preview = build_preview(html, true).expect("a preview");
        assert!(preview.facts.is_empty(), "{:?}", preview.facts);
    }

    #[test]
    fn durations_and_counts_are_formatted_the_way_youtube_writes_them() {
        assert_eq!(parse_iso_duration("PT4M46S"), Some(286));
        assert_eq!(parse_iso_duration("PT1H2M33S"), Some(3753));
        assert_eq!(parse_iso_duration("PT45S"), Some(45));
        assert_eq!(parse_iso_duration("nonsense"), None);

        assert_eq!(format_duration(286), "4:46");
        assert_eq!(format_duration(3753), "1:02:33");
        assert_eq!(format_duration(45), "0:45");

        assert_eq!(compact(847), "847");
        assert_eq!(compact(1_215_370), "1.2M");
        assert_eq!(compact(532_000), "532K");
        assert_eq!(compact(15_400_000), "15M");
        assert_eq!(separated(17_430), "17,430");
        assert_eq!(separated(999), "999");
        assert_eq!(separated(1_215_370), "1,215,370");
    }

    #[test]
    fn dates_lose_the_time_and_the_uploaders_time_zone() {
        assert_eq!(
            format_date("2023-03-03T04:14:46-08:00"),
            Some("3 Mar 2023".into())
        );
        assert_eq!(format_date("2011-05-19"), Some("19 May 2011".into()));
        assert_eq!(format_date("not a date"), None);
    }

    #[test]
    fn json_values_survive_their_escapes() {
        let html = r#"{"ownerChannelName":"Someone \"quoted\" here","viewCount":12345}"#;
        assert_eq!(
            json_string(html, "ownerChannelName"),
            Some("Someone \"quoted\" here".to_string())
        );
        // Written bare in some copies of the player response, quoted in others.
        assert_eq!(json_number(html, "viewCount"), Some(12345));
    }

    #[test]
    fn the_machines_own_network_is_not_a_public_host() {
        for host in [
            "localhost",
            "router.local",
            "vault.internal",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "[::1]",
            "[fe80::1]",
            "[::ffff:127.0.0.1]",
        ] {
            assert!(!is_public_host(host), "{host} should be refused");
        }
        for host in ["example.com", "i.imgur.com", "8.8.8.8", "[2606:4700::1]"] {
            assert!(is_public_host(host), "{host} should be allowed");
        }
    }

    #[test]
    fn only_http_urls_are_fetched() {
        assert!(is_public_url(&Url::parse("https://example.com/a").unwrap()));
        assert!(is_public_url(&Url::parse("http://example.com/a").unwrap()));
        assert!(!is_public_url(&Url::parse("file:///etc/passwd").unwrap()));
        assert!(!is_public_url(&Url::parse("ftp://example.com/a").unwrap()));
    }

    #[test]
    fn reading_stops_once_the_head_is_in() {
        assert!(has_enough(
            b"<html><head><title>x</title></head><body>",
            false
        ));
        assert!(!has_enough(b"<html><head><title>x</title>", false));
        // YouTube waits for the last of the numbers, not the head.
        assert!(!has_enough(b"</head>\"viewCount\":\"1\"", true));
        assert!(has_enough(
            b"\"viewCount\":\"1\",\"likeCount\":\"2\",\"ownerChannelName\":\"x\"",
            true
        ));
    }
}
