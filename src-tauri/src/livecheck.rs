//! Opt-in smoke tests against the real Twitch IRC gateway and the real emote
//! provider APIs.
//!
//! Excluded from the normal suite because it needs the network:
//!   cargo test -- --ignored --nocapture

#![cfg(test)]

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::emotes::Emote;
use crate::irc::parse;
use crate::render::{self, BadgeLookup, EmoteLookup, Segment};
use crate::twitch::badges::BadgeMap;

const CHANNELS: [&str; 4] = ["forsen", "xqc", "sodapoppin", "zackrawrr"];
const LISTEN_FOR: Duration = Duration::from_secs(25);

#[tokio::test]
#[ignore = "hits the live Twitch and 7TV APIs"]
async fn live_pipeline_resolves_real_messages() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("chatwow/", env!("CARGO_PKG_VERSION"), " livecheck"))
        .build()
        .unwrap();

    // 1. Global 7TV set.
    let global = crate::emotes::seventv::fetch_global(&http)
        .await
        .expect("global 7TV set should load");
    println!("global 7TV emotes: {}", global.len());
    assert!(global.len() > 20, "expected a populated global set, got {}", global.len());

    let zero_width: Vec<&String> = global
        .iter()
        .filter(|(_, e)| e.zero_width)
        .map(|(name, _)| name)
        .collect();
    println!("global zero-width (overlay) emotes: {zero_width:?}");
    assert!(
        !zero_width.is_empty(),
        "the global set should contain overlay emotes"
    );

    // 2. Connect anonymously and join.
    let (stream, _) = connect_async("wss://irc-ws.chat.twitch.tv:443")
        .await
        .expect("should connect to the Twitch gateway");
    let (mut write, mut read) = stream.split();

    write
        .send(Message::Text("CAP REQ :twitch.tv/tags twitch.tv/commands".into()))
        .await
        .unwrap();
    write.send(Message::Text("PASS SCHMOOPIIE".into())).await.unwrap();
    write.send(Message::Text("NICK justinfan45678".into())).await.unwrap();
    for channel in CHANNELS {
        write.send(Message::Text(format!("JOIN #{channel}").into())).await.unwrap();
    }

    // 3. Collect for a while.
    let mut room_ids: HashMap<String, String> = HashMap::new();
    let mut raw_messages: Vec<(String, parse::IrcMessage)> = Vec::new();

    let deadline = tokio::time::Instant::now() + LISTEN_FOR;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Ok(Some(Ok(frame))) = tokio::time::timeout(remaining, read.next()).await else {
            break;
        };
        let Message::Text(text) = frame else { continue };

        for line in text.split("\r\n").filter(|l| !l.is_empty()) {
            let Some(msg) = parse::parse(line) else { continue };
            match msg.command.as_str() {
                "PING" => {
                    let token = msg.params.first().cloned().unwrap_or_default();
                    write.send(Message::Text(format!("PONG :{token}").into())).await.unwrap();
                }
                "ROOMSTATE" => {
                    if let (Some(channel), Some(room_id)) = (msg.channel(), msg.tag("room-id")) {
                        room_ids.insert(channel, room_id.to_string());
                    }
                }
                "PRIVMSG" => {
                    if let Some(channel) = msg.channel() {
                        raw_messages.push((channel, msg));
                    }
                }
                _ => {}
            }
        }
    }

    println!("room ids resolved: {room_ids:?}");
    assert_eq!(
        room_ids.len(),
        CHANNELS.len(),
        "ROOMSTATE should give a room-id for every joined channel"
    );

    // 4. Channel 7TV sets, keyed off the room-id we learned from ROOMSTATE.
    let mut channel_emotes: HashMap<String, HashMap<String, Emote>> = HashMap::new();
    for (channel, room_id) in &room_ids {
        let set = crate::emotes::seventv::fetch_channel(&http, room_id)
            .await
            .expect("channel emote fetch should not error");
        println!("#{channel} (room {room_id}): {} 7TV emotes", set.len());
        channel_emotes.insert(channel.clone(), set);
    }
    assert!(
        channel_emotes.values().any(|set| !set.is_empty()),
        "at least one of these channels should have a 7TV emote set"
    );

    // 5. Render everything we captured and report what actually resolved.
    let empty_badges = BadgeMap::new();
    let mut twitch_emotes = 0usize;
    let mut seventv_emotes = 0usize;
    let mut overlays = 0usize;
    let mut colored = 0usize;
    let mut badged = 0usize;
    let mut samples: Vec<String> = Vec::new();

    for (channel, msg) in &raw_messages {
        let lookup = EmoteLookup {
            channel: channel_emotes.get(channel),
            global: &global,
        };
        let badges = BadgeLookup { channel: None, global: &empty_badges };
        let message = render::build_chat_message(msg, channel, &lookup, &badges);

        assert!(
            message.color.starts_with('#') && message.color.len() == 7,
            "every message must resolve to a usable color, got {}",
            message.color
        );
        if msg.tag("color").is_some() {
            colored += 1;
        }
        if !message.badges.is_empty() {
            badged += 1;
        }

        let mut rendered = String::new();
        for segment in &message.segments {
            match segment {
                Segment::Text { text } => rendered.push_str(text),
                Segment::Mention { text } => rendered.push_str(text),
                Segment::Link { text, .. } => rendered.push_str(text),
                Segment::Emote { name, provider, overlays: over, .. } => {
                    if provider == "twitch" {
                        twitch_emotes += 1;
                    } else {
                        seventv_emotes += 1;
                    }
                    overlays += over.len();
                    rendered.push_str(&format!("[{provider}:{name}"));
                    for overlay in over {
                        rendered.push_str(&format!("+{}", overlay.name));
                    }
                    rendered.push(']');
                }
            }
        }

        if samples.len() < 15 && message.segments.iter().any(|s| matches!(s, Segment::Emote { .. }))
        {
            samples.push(format!(
                "#{channel} <{}> {} :: {rendered}",
                message.display_name, message.color
            ));
        }
    }

    println!("\n--- captured {} messages ---", raw_messages.len());
    println!("twitch emotes resolved : {twitch_emotes}");
    println!("7tv emotes resolved    : {seventv_emotes}");
    println!("overlays folded        : {overlays}");
    println!("with explicit color    : {colored}");
    println!("with badges            : {badged}");
    println!("\nsamples:");
    for sample in &samples {
        println!("  {sample}");
    }

    assert!(
        !raw_messages.is_empty(),
        "expected at least some chat traffic across {CHANNELS:?}"
    );
}

/// The BetterTTV and FrankerFaceZ endpoints, against real channels. Their
/// response shapes are hand-mirrored like 7TV's, so this is what catches a
/// provider changing one under us -- an empty map is the symptom, and it looks
/// exactly like a channel that simply has no emotes.
#[tokio::test]
#[ignore = "hits the live BetterTTV and FrankerFaceZ APIs"]
async fn live_bttv_and_ffz_sets_parse() {
    // forsen: carries emotes on both services. (Channel size is no guide --
    // xQc's BTTV set is empty and his FFZ set is one emote.)
    const ROOM_ID: &str = "22484632";

    let http = reqwest::Client::builder()
        .user_agent(concat!("chatwow/", env!("CARGO_PKG_VERSION"), " livecheck"))
        .build()
        .unwrap();

    let bttv_global = crate::emotes::bttv::fetch_global(&http)
        .await
        .expect("global BTTV set should load");
    println!("global BTTV emotes: {}", bttv_global.len());
    assert!(bttv_global.len() > 20, "expected a populated set, got {}", bttv_global.len());

    let ffz_global = crate::emotes::ffz::fetch_global(&http)
        .await
        .expect("global FFZ set should load");
    println!("global FFZ emotes: {}", ffz_global.len());
    // A lower bar than the others on purpose: FFZ's default global set is
    // genuinely small (~15), where BTTV's is dozens. Anything above zero
    // proves the shape parsed; the number itself is FFZ's business.
    assert!(ffz_global.len() > 5, "expected a populated set, got {}", ffz_global.len());

    let bttv_channel = crate::emotes::bttv::fetch_channel(&http, ROOM_ID)
        .await
        .expect("channel BTTV set should load");
    let ffz_channel = crate::emotes::ffz::fetch_channel(&http, ROOM_ID)
        .await
        .expect("channel FFZ set should load");
    println!(
        "forsen: {} BTTV, {} FFZ channel emotes",
        bttv_channel.len(),
        ffz_channel.len()
    );
    // BTTV's channel response splits into a channel's own emotes and the ones
    // it borrows; both are usable in chat, so both have to land here.
    assert!(bttv_channel.len() > 50, "expected forsen's own and shared BTTV emotes");
    assert!(!ffz_channel.is_empty(), "forsen should have FFZ channel emotes");

    // Every url has to be absolute and https -- FFZ answers protocol-relative,
    // and a `//cdn...` src in the webview resolves against `tauri://`.
    for (name, emote) in bttv_global.iter().chain(&ffz_global).chain(&ffz_channel) {
        assert!(
            emote.url.starts_with("https://") && emote.url_large.starts_with("https://"),
            "{name} has a relative url: {} / {}",
            emote.url,
            emote.url_large
        );
        assert!(!emote.id.is_empty(), "{name} has no id to cache it under");
    }

    // A channel neither service knows is an empty map, not an error -- it's
    // the common case for a small streamer and must not break a join.
    let unknown = crate::emotes::bttv::fetch_channel(&http, "1")
        .await
        .expect("an unknown channel is not an error");
    assert!(unknown.is_empty());
    let unknown = crate::emotes::ffz::fetch_channel(&http, "1")
        .await
        .expect("an unknown channel is not an error");
    assert!(unknown.is_empty());
}

/// The 7TV badge lookup, batched the way the resolver batches it. Worth a live
/// check for the same reason as the emote sets, and one more: the query is
/// built by hand as a GraphQL document, so a renamed field shows up as every
/// chatter silently having no badge.
#[tokio::test]
#[ignore = "hits the live 7TV GraphQL API"]
async fn live_seventv_badges_resolve() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("chatwow/", env!("CARGO_PKG_VERSION"), " livecheck"))
        .build()
        .unwrap();

    // xQc and NymN both wear one; sodapoppin has a 7TV account with no badge
    // equipped, and 1 is nobody. All four are answers, and only two are badges.
    let ids: Vec<String> =
        ["71092938", "62300805", "26301881", "1"].iter().map(|id| id.to_string()).collect();

    let badges = crate::emotes::seventv_badges::fetch(&http, &ids)
        .await
        .expect("the badge query should answer");

    for (id, badge) in &badges {
        println!("{id}: {} ({})", badge.title, badge.url);
    }

    assert!(badges.contains_key("71092938"), "xqc wears a badge");
    assert!(!badges.contains_key("26301881"), "sodapoppin has none equipped");
    assert!(!badges.contains_key("1"), "and nobody is nobody");

    for (id, badge) in &badges {
        assert!(badge.url.starts_with("https://"), "{id}: relative url {}", badge.url);
        assert!(!badge.title.is_empty(), "{id}: a badge with no name");
        assert!(badge.id.starts_with("7tv-"), "{id}: unnamespaced badge id {}", badge.id);
    }
}

#[tokio::test]
#[ignore = "hits the live ivr.fi API"]
async fn live_user_card_history_resolves() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("chatwow/", env!("CARGO_PKG_VERSION"), " livecheck"))
        .build()
        .unwrap();

    // Signed out, which is the path that has to keep working without a token:
    // the avatar and account age come from ivr.fi rather than Helix, and the
    // follow/sub half never had another source to begin with.
    let card = crate::usercard::fetch(&http, None, "nymn", "forsen")
        .await
        .expect("the card should load");

    println!("{card:?}");
    assert!(card.avatar_url.starts_with("https://"), "avatar: {}", card.avatar_url);
    assert!(card.created_at.starts_with("20"), "created: {}", card.created_at);

    let history = card.history.expect("ivr.fi should have answered");
    // NymN has followed forsen since 2015 and subscribed for years, so any
    // shape where those come back empty means the parse has drifted.
    assert!(history.followed_at.starts_with("2015"), "followed: {}", history.followed_at);
    assert!(history.sub_months > 100, "sub months: {}", history.sub_months);

    // Nobody is nobody, in either half -- so there's no card at all.
    let missing = crate::usercard::fetch(&http, None, "thisuserdoesnotexist99123", "forsen").await;
    assert!(missing.is_err(), "a name Twitch doesn't know should be an error");
}

#[tokio::test]
#[ignore = "fetches real pages off the internet"]
async fn live_link_previews_read_real_pages() {
    let http = crate::linkinfo::build_client();

    for url in ["https://example.com/", "https://www.twitch.tv/", "https://7tv.app/"] {
        let preview = crate::linkinfo::preview(&http, url).await;
        println!("{url} -> {preview:?}");
        let preview = preview.expect("the request should not fail").expect("a preview");
        assert!(!preview.title.is_empty(), "{url} should have a title");
    }

    // The one site with a card's worth of things to say. Every row here comes
    // from a different part of the page, so a drift in any of them shows up as
    // one missing row rather than a failure -- which is why they're checked by
    // label rather than by count.
    let video = crate::linkinfo::preview(&http, "https://youtu.be/qMpBobAonKs")
        .await
        .expect("the request should not fail")
        .expect("a video should preview");
    println!("{video:#?}");
    assert_eq!(video.title, "Hold Me Now");
    assert!(!video.description.is_empty(), "a video has a description");
    assert!(video.image.starts_with("https://"), "image: {}", video.image);
    for label in ["Channel", "Duration", "Published", "Views", "Likes"] {
        let row = video.facts.iter().find(|fact| fact.label == label);
        assert!(row.is_some(), "no {label} row in {:?}", video.facts);
        assert!(!row.unwrap().value.is_empty(), "{label} is empty");
    }

    // Not a page, so nothing to preview -- and, more to the point, not
    // something to read a megabyte of looking for one.
    let image = crate::linkinfo::preview(
        &http,
        "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0",
    )
    .await
    .expect("the request should not fail");
    assert_eq!(image, None, "an image is not a page with a preview");

    // The machine's own network is off limits however the url is written.
    for refused in ["http://127.0.0.1:1420/", "http://localhost:1420/", "file:///etc/hosts"] {
        let answer = crate::linkinfo::preview(&http, refused).await;
        assert!(
            matches!(answer, Ok(None) | Err(_)),
            "{refused} should not be fetched: {answer:?}"
        );
    }
}

/// The Twitch half of link previews, which needs a token -- Helix has no
/// anonymous mode and this app has no client secret to mint an app token with.
/// Supply one from a signed-in session to run it:
///
///   TWITCH_TEST_CLIENT_ID=... TWITCH_TEST_TOKEN=... \
///     cargo test -- --ignored --nocapture live_twitch_link
#[tokio::test]
#[ignore = "needs a Twitch token in TWITCH_TEST_CLIENT_ID / TWITCH_TEST_TOKEN"]
async fn live_twitch_link_previews_resolve() {
    let (Ok(client_id), Ok(token)) = (
        std::env::var("TWITCH_TEST_CLIENT_ID"),
        std::env::var("TWITCH_TEST_TOKEN"),
    ) else {
        println!("skipped: set TWITCH_TEST_CLIENT_ID and TWITCH_TEST_TOKEN to run this");
        return;
    };

    let http = reqwest::Client::new();
    let helix = crate::twitch::helix::Helix {
        client: &http,
        client_id: &client_id,
        token: &token,
    };

    // A channel answers live or offline, so this holds either way -- the rows
    // differ, the card doesn't.
    let url = reqwest::Url::parse("https://www.twitch.tv/forsen").unwrap();
    let link = crate::twitch::links::parse(&url).expect("a channel link");
    let preview = crate::twitch::links::preview(&helix, &link)
        .await
        .expect("Helix should answer")
        .expect("a channel that exists should preview");
    println!("{preview:#?}");
    assert!(!preview.title.is_empty());
    // Live leads with the channel, offline with the status -- either is a card.
    let first = preview.facts.first().map(|fact| fact.label.as_str());
    assert!(matches!(first, Some("Channel" | "Status")), "leading row: {first:?}");

    // A name Twitch doesn't know is a miss, not an error: the caller falls
    // back to reading the page.
    let missing = reqwest::Url::parse("https://www.twitch.tv/thisuserdoesnotexist99123").unwrap();
    let link = crate::twitch::links::parse(&missing).expect("a channel link");
    assert_eq!(
        crate::twitch::links::preview(&helix, &link).await.expect("no error"),
        None
    );
}
