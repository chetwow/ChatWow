//! Previews for links to Twitch itself, out of Helix rather than the page.
//!
//! A twitch.tv page tells a scraper almost nothing: the site is a React shell,
//! and its OpenGraph tags are a channel name and a generic blurb. Helix knows
//! all of it -- who clipped what, from which stream, how long it runs, how many
//! people are watching right now -- and this app already holds a token, so the
//! one site chat links most is also the one it can say most about.
//!
//! Three shapes are recognized, and they're the three people paste: a clip, a
//! VOD, and a channel. Anything else on the domain (the directory, a settings
//! page) is an ordinary link and previews like one.
//!
//! Signed out there's no token -- this app is a public client with no secret,
//! so there's no app token to fall back on either -- and every one of these
//! falls back to `linkinfo`'s scrape of the page, which is thin but not empty.
//! Same for a Helix call that fails: the generic path is always there, so a
//! rate limit or an outage costs detail rather than the preview.

use anyhow::Result;
use reqwest::Url;
use serde::Deserialize;

use super::helix::Helix;
use crate::linkinfo::{compact, format_date, format_duration, Fact, LinkPreview};

/// How long a preview of something *happening* stays fresh. A viewer count and
/// an uptime are wrong within minutes, and the frontend caches what it's given
/// -- so the answer carries its own shelf life rather than the cache guessing.
const LIVE_TTL: u32 = 120;

/// Thumbnails come back as templates. 480x270 is the size the card draws at on
/// a normal window, doubled for the pixel ratio it might be drawn on.
const THUMB_WIDTH: u32 = 960;
const THUMB_HEIGHT: u32 = 540;

/// The paths on twitch.tv that aren't somebody's channel. Not exhaustive --
/// it doesn't need to be, since an unknown one costs a Helix miss and a
/// fallback to the ordinary preview, not a wrong answer.
const RESERVED: [&str; 24] = [
    "directory",
    "videos",
    "settings",
    "wallet",
    "subscriptions",
    "inventory",
    "drops",
    "downloads",
    "store",
    "jobs",
    "turbo",
    "prime",
    "friends",
    "popout",
    "moderator",
    "search",
    "following",
    "collections",
    "payments",
    "products",
    "broadcast",
    "dashboard",
    "activate",
    "team",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TwitchLink {
    /// A clip, by slug. Both url shapes lead here.
    Clip(String),
    /// A VOD, by numeric id.
    Video(String),
    /// Someone's channel, by login.
    Channel(String),
}

/// Which of the three this is, or `None` for anything else on the domain.
pub fn parse(url: &Url) -> Option<TwitchLink> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let segments: Vec<&str> = url
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();

    match (host, segments.as_slice()) {
        ("clips.twitch.tv", [slug]) => slug_ok(slug).then(|| TwitchLink::Clip(slug.to_string())),
        ("twitch.tv" | "m.twitch.tv", ["videos", id]) => id
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| TwitchLink::Video(id.to_string())),
        ("twitch.tv" | "m.twitch.tv", [_channel, "clip", slug]) => {
            slug_ok(slug).then(|| TwitchLink::Clip(slug.to_string()))
        }
        ("twitch.tv" | "m.twitch.tv", [login]) => {
            let lower = login.to_ascii_lowercase();
            (is_login(&lower) && !RESERVED.contains(&lower.as_str()))
                .then_some(TwitchLink::Channel(lower))
        }
        _ => None,
    }
}

/// Clip slugs are Twitch's own invention -- long, mixed case, hyphenated, and
/// occasionally with a trailing segment of digits. Checked only for the
/// characters that could mean something else in a query string.
fn slug_ok(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 120
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_login(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 25
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What Helix knows about this link, or `None` when it knows nothing -- a
/// deleted clip, a channel that no longer exists. The caller falls back to the
/// ordinary page preview either way.
pub async fn preview(helix: &Helix<'_>, link: &TwitchLink) -> Result<Option<LinkPreview>> {
    match link {
        TwitchLink::Clip(slug) => clip(helix, slug).await,
        TwitchLink::Video(id) => video(helix, id).await,
        TwitchLink::Channel(login) => channel(helix, login).await,
    }
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct Clip {
    #[serde(default)]
    title: String,
    #[serde(default)]
    broadcaster_name: String,
    #[serde(default)]
    creator_name: String,
    #[serde(default)]
    game_id: String,
    #[serde(default)]
    view_count: u64,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    thumbnail_url: String,
    /// Seconds, and a float -- clips are cut to the tenth.
    #[serde(default)]
    duration: f64,
}

async fn clip(helix: &Helix<'_>, slug: &str) -> Result<Option<LinkPreview>> {
    let response = helix.get("clips", &[("id", slug)]).await?;
    let Some(clip) = first::<Clip>(&response) else {
        return Ok(None);
    };
    // One more call, and only when there's an id to spend it on: the clip
    // carries the game's id, never its name.
    let game = match clip.game_id.is_empty() {
        true => None,
        false => game_name(helix, &clip.game_id).await,
    };
    Ok(Some(clip_preview(&clip, game)))
}

async fn game_name(helix: &Helix<'_>, id: &str) -> Option<String> {
    let response = helix.get("games", &[("id", id)]).await.ok()?;
    let name = response["data"].get(0)?["name"].as_str()?.to_string();
    (!name.is_empty()).then_some(name)
}

fn clip_preview(clip: &Clip, game: Option<String>) -> LinkPreview {
    let mut facts = vec![Fact::new("Channel", clip.broadcaster_name.clone())];
    if !clip.creator_name.is_empty() {
        facts.push(Fact::new("Clipped by", clip.creator_name.clone()));
    }
    if let Some(game) = game {
        facts.push(Fact::new("Game", game));
    }
    if clip.duration >= 1.0 {
        facts.push(Fact::new("Length", format_duration(clip.duration as u64)));
    }
    facts.push(Fact::new("Views", compact(clip.view_count)));
    if let Some(date) = format_date(&clip.created_at) {
        facts.push(Fact::new("Clipped", date));
    }

    LinkPreview {
        title: clip.title.clone(),
        description: String::new(),
        image: sized(&clip.thumbnail_url),
        facts,
        ttl_seconds: 0,
    }
}

// ---------------------------------------------------------------------------
// VODs
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct Video {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    view_count: u64,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    thumbnail_url: String,
    /// Twitch's own shorthand: "3h21m33s", "48m10s", "22s".
    #[serde(default)]
    duration: String,
}

async fn video(helix: &Helix<'_>, id: &str) -> Result<Option<LinkPreview>> {
    let response = helix.get("videos", &[("id", id)]).await?;
    Ok(first::<Video>(&response).map(|video| video_preview(&video)))
}

fn video_preview(video: &Video) -> LinkPreview {
    let mut facts = vec![Fact::new("Channel", video.user_name.clone())];
    if let Some(seconds) = parse_twitch_duration(&video.duration) {
        facts.push(Fact::new("Length", format_duration(seconds)));
    }
    facts.push(Fact::new("Views", compact(video.view_count)));
    if let Some(date) = format_date(&video.created_at) {
        facts.push(Fact::new("Streamed", date));
    }

    LinkPreview {
        title: video.title.clone(),
        description: video.description.clone(),
        image: sized(&video.thumbnail_url),
        facts,
        ttl_seconds: 0,
    }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct Stream {
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    viewer_count: u64,
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    thumbnail_url: String,
    /// "live" for a real broadcast; a rerun comes back here too and isn't the
    /// streamer being on, exactly as in `streams::live_logins`.
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Debug, Default, Deserialize)]
struct User {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    profile_image_url: String,
}

#[derive(Debug, Default, Deserialize)]
struct Channel {
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
}

/// Live or not, which is two different cards.
///
/// The stream and the user are asked for together -- they're independent, and
/// the offline card needs the user either way. Only an offline channel pays for
/// a third call, to find out what it was last doing.
async fn channel(helix: &Helix<'_>, login: &str) -> Result<Option<LinkPreview>> {
    // Bound rather than inlined: a temporary array inside `join!` doesn't
    // outlive the futures that borrow it.
    let stream_query = [("user_login", login)];
    let user_query = [("login", login)];
    let (streams, users) = tokio::join!(
        helix.get("streams", &stream_query),
        helix.get("users", &user_query)
    );
    let Some(user) = users.ok().as_ref().and_then(first::<User>) else {
        // No such channel. Nothing worth falling back to Helix for.
        return Ok(None);
    };

    let stream = streams
        .ok()
        .as_ref()
        .and_then(first::<Stream>)
        .filter(|stream| stream.kind == "live");
    if let Some(stream) = stream {
        return Ok(Some(live_preview(&stream, &user, now_epoch())));
    }

    let last = helix
        .get("channels", &[("broadcaster_id", user.id.as_str())])
        .await
        .ok()
        .as_ref()
        .and_then(first::<Channel>);
    Ok(Some(offline_preview(&user, last.as_ref())))
}

fn live_preview(stream: &Stream, user: &User, now: i64) -> LinkPreview {
    let mut facts = vec![Fact::new(
        "Channel",
        if user.display_name.is_empty() {
            stream.user_name.clone()
        } else {
            user.display_name.clone()
        },
    )];
    if !stream.game_name.is_empty() {
        facts.push(Fact::new("Playing", stream.game_name.clone()));
    }
    facts.push(Fact::new("Viewers", compact(stream.viewer_count)));
    if let Some(uptime) = uptime(&stream.started_at, now) {
        facts.push(Fact::new("Live for", uptime));
    }

    LinkPreview {
        // The stream's own title, which is what a channel link is usually
        // pointing at -- the name is a row below it.
        title: if stream.title.is_empty() {
            format!("{} is live", stream.user_name)
        } else {
            stream.title.clone()
        },
        description: String::new(),
        image: sized(&stream.thumbnail_url),
        facts,
        // Viewers and uptime are wrong within minutes.
        ttl_seconds: LIVE_TTL,
    }
}

fn offline_preview(user: &User, last: Option<&Channel>) -> LinkPreview {
    let mut facts = vec![Fact::new("Status", "Offline")];
    if let Some(channel) = last {
        if !channel.game_name.is_empty() {
            facts.push(Fact::new("Last played", channel.game_name.clone()));
        }
        if !channel.title.is_empty() {
            facts.push(Fact::new("Last title", channel.title.clone()));
        }
    }

    LinkPreview {
        title: user.display_name.clone(),
        // Their channel bio, which is the only thing an offline page has to
        // say that the name doesn't.
        description: user.description.clone(),
        image: user.profile_image_url.clone(),
        facts,
        ttl_seconds: 0,
    }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/// The first row of a Helix `data` array, parsed. Every one of these endpoints
/// answers with an array of at most one for the queries above, and an empty one
/// for "no such thing" rather than a 404.
fn first<T: for<'de> Deserialize<'de>>(response: &serde_json::Value) -> Option<T> {
    let row = response["data"].get(0)?;
    serde_json::from_value(row.clone()).ok()
}

/// Thumbnails arrive as templates, in two different notations depending on the
/// endpoint. A url with neither is already an image and passes through.
fn sized(url: &str) -> String {
    url.replace("%{width}", &THUMB_WIDTH.to_string())
        .replace("%{height}", &THUMB_HEIGHT.to_string())
        .replace("{width}", &THUMB_WIDTH.to_string())
        .replace("{height}", &THUMB_HEIGHT.to_string())
}

/// `3h21m33s` -> 12093. Twitch's own shorthand, and only in that order.
fn parse_twitch_duration(text: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut digits = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let value: u64 = digits.parse().ok()?;
        digits.clear();
        total += match c {
            'h' => value * 3600,
            'm' => value * 60,
            's' => value,
            _ => return None,
        };
    }
    (digits.is_empty() && total > 0).then_some(total)
}

/// `2h 14m`, or `14m` for the first hour. Rounded down, the way a stream's own
/// uptime counter reads.
fn uptime(started_at: &str, now: i64) -> Option<String> {
    let started = epoch_seconds(started_at)?;
    let elapsed = now.checked_sub(started).filter(|seconds| *seconds >= 0)?;
    let (hours, minutes) = (elapsed / 3600, (elapsed / 60) % 60);
    Some(match hours {
        0 => format!("{minutes}m"),
        _ => format!("{hours}h {minutes}m"),
    })
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Seconds since the epoch for `2023-03-03T04:14:46Z`. Twitch stamps every one
/// of these in UTC, which is what makes this arithmetic rather than a date
/// library: no zones, no locales, and the only use is a difference in minutes.
fn epoch_seconds(iso: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| -> Option<i64> { iso.get(range)?.parse().ok() };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Days between 1970-01-01 and this date. Hinnant's algorithm, which is the
/// short way to do this without pulling in a calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_position = (month + 9) % 12;
    let day_of_year = (153 * month_position + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(url: &str) -> Option<TwitchLink> {
        parse(&Url::parse(url).unwrap())
    }

    #[test]
    fn the_three_shapes_people_paste_are_recognized() {
        assert_eq!(
            link("https://clips.twitch.tv/SoftKindPuppyKappa-abc123"),
            Some(TwitchLink::Clip("SoftKindPuppyKappa-abc123".into()))
        );
        assert_eq!(
            link("https://www.twitch.tv/forsen/clip/SoftKindPuppyKappa-abc123?featured=false"),
            Some(TwitchLink::Clip("SoftKindPuppyKappa-abc123".into()))
        );
        assert_eq!(
            link("https://www.twitch.tv/videos/2184059127?t=01h20m"),
            Some(TwitchLink::Video("2184059127".into()))
        );
        assert_eq!(
            link("https://m.twitch.tv/forsen"),
            Some(TwitchLink::Channel("forsen".into()))
        );
        // Case is Twitch's business in a channel url, ours in a lookup.
        assert_eq!(
            link("https://twitch.tv/Forsen"),
            Some(TwitchLink::Channel("forsen".into()))
        );
    }

    #[test]
    fn the_rest_of_the_site_is_an_ordinary_link() {
        assert_eq!(link("https://www.twitch.tv/directory"), None);
        assert_eq!(link("https://www.twitch.tv/settings"), None);
        assert_eq!(link("https://www.twitch.tv/"), None);
        assert_eq!(link("https://www.twitch.tv/forsen/videos"), None);
        assert_eq!(link("https://dashboard.twitch.tv/u/forsen"), None);
        // Not Twitch at all, however much it looks like it.
        assert_eq!(link("https://twitch.tv.example.com/forsen"), None);
        assert_eq!(link("https://www.twitch.tv/videos/not-a-number"), None);
    }

    #[test]
    fn a_clip_reads_back_as_a_card() {
        let clip = Clip {
            title: "insane play".into(),
            broadcaster_name: "Forsen".into(),
            creator_name: "someone".into(),
            game_id: "512710".into(),
            view_count: 15_400,
            created_at: "2024-11-02T19:04:11Z".into(),
            thumbnail_url: "https://clips-media/preview.jpg".into(),
            duration: 28.5,
        };
        let preview = clip_preview(&clip, Some("Call of Duty".into()));
        assert_eq!(preview.title, "insane play");
        assert_eq!(preview.image, "https://clips-media/preview.jpg");
        assert_eq!(
            rows(&preview),
            vec![
                ("Channel", "Forsen"),
                ("Clipped by", "someone"),
                ("Game", "Call of Duty"),
                ("Length", "0:28"),
                ("Views", "15K"),
                ("Clipped", "2 Nov 2024"),
            ]
        );
        // Nothing about a clip changes, so it's cached for the session.
        assert_eq!(preview.ttl_seconds, 0);
    }

    #[test]
    fn a_clip_with_no_game_loses_the_row_rather_than_the_card() {
        let clip = Clip {
            title: "clip".into(),
            broadcaster_name: "Forsen".into(),
            ..Clip::default()
        };
        let preview = clip_preview(&clip, None);
        assert_eq!(rows(&preview), vec![("Channel", "Forsen"), ("Views", "0")]);
    }

    #[test]
    fn a_vod_carries_its_length_in_twitchs_own_shorthand() {
        let video = Video {
            title: "a long one".into(),
            description: "sub only".into(),
            user_name: "NymN".into(),
            view_count: 1_215_370,
            created_at: "2023-03-03T04:14:46Z".into(),
            thumbnail_url: "https://vod/%{width}x%{height}.jpg".into(),
            duration: "3h21m33s".into(),
        };
        let preview = video_preview(&video);
        assert_eq!(preview.description, "sub only");
        assert_eq!(preview.image, "https://vod/960x540.jpg");
        assert_eq!(
            rows(&preview),
            vec![
                ("Channel", "NymN"),
                ("Length", "3:21:33"),
                ("Views", "1.2M"),
                ("Streamed", "3 Mar 2023"),
            ]
        );
    }

    #[test]
    fn a_live_channel_leads_with_the_stream_title() {
        let stream = Stream {
            user_name: "Forsen".into(),
            game_name: "Minecraft".into(),
            title: "wide peepo".into(),
            viewer_count: 24_512,
            started_at: "2024-11-02T12:00:00Z".into(),
            thumbnail_url: "https://live/{width}x{height}.jpg".into(),
            kind: "live".into(),
        };
        let user = User {
            display_name: "Forsen".into(),
            ..User::default()
        };
        // Two hours and fourteen minutes after it started.
        let now = epoch_seconds("2024-11-02T14:14:30Z").unwrap();
        let preview = live_preview(&stream, &user, now);

        assert_eq!(preview.title, "wide peepo");
        assert_eq!(preview.image, "https://live/960x540.jpg");
        assert_eq!(
            rows(&preview),
            vec![
                ("Channel", "Forsen"),
                ("Playing", "Minecraft"),
                ("Viewers", "25K"),
                ("Live for", "2h 14m"),
            ]
        );
        // A viewer count goes stale, so this one says how long it's good for.
        assert_eq!(preview.ttl_seconds, LIVE_TTL);
    }

    #[test]
    fn an_offline_channel_shows_who_they_are_and_what_they_were_doing() {
        let user = User {
            id: "22484632".into(),
            display_name: "Forsen".into(),
            description: "swedish".into(),
            profile_image_url: "https://avatar.png".into(),
        };
        let last = Channel {
            game_name: "Minecraft".into(),
            title: "wide peepo".into(),
        };
        let preview = offline_preview(&user, Some(&last));
        assert_eq!(preview.title, "Forsen");
        assert_eq!(preview.description, "swedish");
        assert_eq!(preview.image, "https://avatar.png");
        assert_eq!(
            rows(&preview),
            vec![
                ("Status", "Offline"),
                ("Last played", "Minecraft"),
                ("Last title", "wide peepo"),
            ]
        );
    }

    #[test]
    fn durations_and_uptimes_are_read_the_way_twitch_writes_them() {
        assert_eq!(parse_twitch_duration("3h21m33s"), Some(12_093));
        assert_eq!(parse_twitch_duration("48m10s"), Some(2_890));
        assert_eq!(parse_twitch_duration("22s"), Some(22));
        // A trailing number with no unit is a shape we don't understand.
        assert_eq!(parse_twitch_duration("3h20"), None);
        assert_eq!(parse_twitch_duration(""), None);

        let now = epoch_seconds("2024-11-02T14:14:30Z").unwrap();
        assert_eq!(
            uptime("2024-11-02T12:00:00Z", now).as_deref(),
            Some("2h 14m")
        );
        assert_eq!(uptime("2024-11-02T14:00:00Z", now).as_deref(), Some("14m"));
        // A clock behind the stream's start reads as no uptime at all rather
        // than a negative one.
        assert_eq!(uptime("2024-11-02T15:00:00Z", now), None);
        assert_eq!(uptime("nonsense", now), None);
    }

    #[test]
    fn the_epoch_arithmetic_agrees_with_the_calendar() {
        assert_eq!(epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_seconds("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(epoch_seconds("2023-03-03T04:14:46Z"), Some(1_677_816_886));
    }

    fn rows(preview: &LinkPreview) -> Vec<(&str, &str)> {
        preview
            .facts
            .iter()
            .map(|fact| (fact.label.as_str(), fact.value.as_str()))
            .collect()
    }
}
