//! Opt-in smoke test against the real Twitch IRC gateway and the real 7TV API.
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
        .user_agent("chatwow/0.1 livecheck")
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
