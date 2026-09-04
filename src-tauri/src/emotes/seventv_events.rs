//! 7TV's EventAPI: a channel's emote set changing while you're reading it.
//!
//! A channel's sets are fetched once, on join, so without this an emote added
//! or removed mid-stream wouldn't render -- or stop rendering -- until the tab
//! was closed and opened again. 7TV pushes those changes over a WebSocket, and
//! this folds them into `ChannelData` and says so in chat.
//!
//! One socket for the whole app, unlike Twitch's EventSub. These events are
//! anonymous and belong to the *room*: there's nothing to sign in as, so there
//! is no reason to have one per account, and a subscription names an emote set
//! rather than a channel or a login. `AppState::seventv_events` is what tells
//! this which sets are worth watching as tabs come and go.
//!
//! The announcement is a plain notice, one per account with a tab on the
//! channel -- a message routes by the account it's stamped with, and this one
//! is news for every tab showing that room.

use anyhow::Result;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::emotes::{seventv, Emote};
use crate::irc::client::MessageSink;
use crate::render;
use crate::state::AppState;

const WS_URL: &str = "wss://events.7tv.io/v3";
/// The one event type this app subscribes to.
const EMOTE_SET_UPDATE: &str = "emote_set.update";
/// Client opcodes. The server's are matched by number in `classify`.
const OP_SUBSCRIBE: u8 = 35;
const OP_UNSUBSCRIBE: u8 = 36;
/// How many emote names a line spells out before it says "and N more".
const NAMES_SHOWN: usize = 5;

type Socket = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

/// An emote as a change names it. Both halves matter: the name is what a
/// chatter types, and the id is what says this is the emote we're holding
/// under that name rather than some other provider's.
#[derive(Debug, PartialEq, Eq)]
pub struct NamedEmote {
    pub id: String,
    pub name: String,
}

/// An emote kept but re-aliased. From a chatter's side this is the old name
/// going and a new one arriving, which is why it's announced at all.
#[derive(Debug, PartialEq, Eq)]
pub struct Rename {
    pub id: String,
    pub from: String,
    pub to: String,
}

/// One set's worth of change, as a single dispatch describes it. 7TV batches:
/// a streamer emptying a set sends one of these, not fifty.
#[derive(Debug, Default, PartialEq)]
pub struct SetUpdate {
    /// The emote set's id -- what a subscription named, and what matches this
    /// back to the channels drawing from it.
    pub set: String,
    /// Who did it, as 7TV displays them. Empty when the dispatch didn't say.
    pub actor: String,
    pub added: Vec<Emote>,
    pub removed: Vec<NamedEmote>,
    pub renamed: Vec<Rename>,
}

impl SetUpdate {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.renamed.is_empty()
    }
}

/// What one frame from the socket means to us.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// The session is up. Nothing to answer, but it's when subscriptions go
    /// out: a subscribe sent before this has no session to attach to.
    Hello,
    /// Come back on a fresh socket -- 7TV is retiring this one, or has ended
    /// the stream. There's no resume url to follow, unlike Twitch's.
    Restart,
    Update(SetUpdate),
    /// Heartbeats, acks, errors, and every event type we didn't ask for.
    Ignored,
}

/// Read one frame. Anything malformed or unrecognized is ignored rather than
/// treated as an error: the socket is fine, this frame just isn't for us.
pub fn classify(raw: &str) -> Incoming {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Incoming::Ignored;
    };

    match value["op"].as_u64() {
        // Dispatch, Hello, Reconnect, End of Stream.
        Some(0) => dispatch(&value["d"]),
        Some(1) => Incoming::Hello,
        Some(4) | Some(7) => Incoming::Restart,
        _ => Incoming::Ignored,
    }
}

fn dispatch(payload: &Value) -> Incoming {
    if payload["type"].as_str() != Some(EMOTE_SET_UPDATE) {
        return Incoming::Ignored;
    }
    let body = &payload["body"];
    let Some(set) = body["id"].as_str().filter(|id| !id.is_empty()) else {
        return Incoming::Ignored;
    };

    let update = SetUpdate {
        set: set.to_string(),
        actor: body["actor"]["display_name"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        // `pushed` carries the whole set entry, so an added emote is
        // renderable straight away without going back to the API for it.
        added: emote_changes(&body["pushed"])
            .filter_map(|change| seventv::emote_from_value(&change["value"]))
            .collect(),
        removed: emote_changes(&body["pulled"])
            .filter_map(|change| named(&change["old_value"]))
            .collect(),
        renamed: emote_changes(&body["updated"])
            .filter_map(renamed)
            .collect(),
    };

    match update.is_empty() {
        // A set can be updated in ways that aren't about its emotes at all --
        // renaming the set, changing its capacity.
        true => Incoming::Ignored,
        false => Incoming::Update(update),
    }
}

/// The entries of one change list that are about emotes. A dispatch describes
/// every field that moved, and the set's own name is one of them.
fn emote_changes(list: &Value) -> impl Iterator<Item = &Value> {
    list.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|change| change["key"].as_str() == Some("emotes"))
}

fn named(value: &Value) -> Option<NamedEmote> {
    let id = value["id"].as_str().filter(|id| !id.is_empty())?;
    let name = value["name"].as_str().filter(|name| !name.is_empty())?;
    Some(NamedEmote {
        id: id.to_string(),
        name: name.to_string(),
    })
}

/// A rename, read from the pair a change carries. Only the alias is read from
/// the new value -- an `updated` entry isn't guaranteed to repeat the image,
/// and we already hold it under the old name.
fn renamed(change: &Value) -> Option<Rename> {
    let before = named(&change["old_value"])?;
    let after = named(&change["value"])?;
    if before.name == after.name {
        return None;
    }
    Some(Rename {
        id: after.id,
        from: before.name,
        to: after.name,
    })
}

/// The emote we're holding under a name, if it's the 7TV one this change is
/// about. Guards every removal: a name can also be some other provider's, or a
/// different 7TV emote aliased over the top.
fn ours<'a>(merged: &'a HashMap<String, Emote>, name: &str, id: &str) -> Option<&'a Emote> {
    merged
        .get(name)
        .filter(|emote| emote.provider == "7tv" && emote.id == id)
}

/// Take a 7TV emote out of the merged map, putting back whatever name it was
/// standing on top of. 7TV wins a shared name, so removing one of its emotes
/// can uncover an FFZ or BTTV emote that was there all along.
fn uncover(
    merged: &mut HashMap<String, Emote>,
    others: &HashMap<String, Emote>,
    name: &str,
    id: &str,
) -> bool {
    if ours(merged, name, id).is_none() {
        return false;
    }
    match others.get(name) {
        Some(shadowed) => merged.insert(name.to_string(), shadowed.clone()),
        None => merged.remove(name),
    };
    true
}

/// Fold one update into every open channel drawing from that set. Returns the
/// channels that actually moved, which is what gets told about it.
fn apply(state: &AppState, update: &SetUpdate) -> Vec<String> {
    let mut data = state.data.write();
    let mut touched = Vec::new();

    for (channel, entry) in data.iter_mut() {
        if entry.seventv_set.as_deref() != Some(update.set.as_str()) {
            continue;
        }

        for emote in &update.added {
            entry.emotes.insert(emote.name.clone(), emote.clone());
        }
        for gone in &update.removed {
            uncover(&mut entry.emotes, &entry.other_emotes, &gone.name, &gone.id);
        }
        for rename in &update.renamed {
            let Some(mut emote) = ours(&entry.emotes, &rename.from, &rename.id).cloned() else {
                continue;
            };
            uncover(
                &mut entry.emotes,
                &entry.other_emotes,
                &rename.from,
                &rename.id,
            );
            emote.name = rename.to.clone();
            entry.emotes.insert(rename.to.clone(), emote);
        }

        entry.emote_revision = entry.emote_revision.wrapping_add(1);
        touched.push(channel.clone());
    }

    touched
}

/// "catJAM", "catJAM and PogU", "catJAM, PogU and KEKW", and past five names
/// "a, b, c, d, e and 7 more" -- a set emptied in one go is one line, not
/// fifty.
fn listed(names: &[&str]) -> String {
    if names.len() > NAMES_SHOWN {
        let shown = names[..NAMES_SHOWN].join(", ");
        return format!("{shown} and {} more", names.len() - NAMES_SHOWN);
    }
    match names.split_last() {
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// What to say about an update: one line per kind of change, and one line for
/// a pile of renames rather than one each.
fn lines(update: &SetUpdate) -> Vec<String> {
    // The actor sits in front of the verb, so a dispatch that didn't name one
    // reads as "7TV: added catJAM" rather than losing the subject entirely.
    let who = match update.actor.is_empty() {
        true => String::new(),
        false => format!("{} ", update.actor),
    };
    let mut lines = Vec::new();

    if !update.added.is_empty() {
        let names: Vec<&str> = update.added.iter().map(|e| e.name.as_str()).collect();
        lines.push(format!("7TV: {who}added {}", listed(&names)));
    }
    if !update.removed.is_empty() {
        let names: Vec<&str> = update.removed.iter().map(|e| e.name.as_str()).collect();
        lines.push(format!("7TV: {who}removed {}", listed(&names)));
    }
    if update.renamed.len() > NAMES_SHOWN {
        lines.push(format!("7TV: {who}renamed {} emotes", update.renamed.len()));
    } else {
        for rename in &update.renamed {
            lines.push(format!(
                "7TV: {who}renamed {} to {}",
                rename.from, rename.to
            ));
        }
    }

    lines
}

/// Apply an update and tell the UI about it: a notice in each affected tab,
/// and the new emote count so completion is rebuilt off the changed set.
fn handle(app: &AppHandle, state: &Arc<AppState>, sink: &MessageSink, update: &SetUpdate) {
    let touched = apply(state, update);
    if touched.is_empty() {
        return;
    }

    let lines = lines(update);

    for channel in touched {
        for line in &lines {
            // Stamped once per account with a tab here: the change is the
            // room's, and a message reaches a tab by the account it names.
            for account in state.accounts_in(&channel) {
                let mut notice = render::notice(&channel, line.clone());
                notice.account = account;
                let _ = sink.send(notice);
            }
        }

        let count = state
            .data
            .read()
            .get(&channel)
            .map(|data| data.emotes.len())
            .unwrap_or(0);
        let _ = app.emit(
            "chat://emote-set",
            json!({ "channel": channel, "emoteCount": count }),
        );
    }
}

fn frame(op: u8, set: &str) -> Message {
    let body = json!({
        "op": op,
        "d": { "type": EMOTE_SET_UPDATE, "condition": { "object_id": set } },
    });
    Message::Text(body.to_string().into())
}

/// Which sets this socket should be subscribed to right now.
fn wanted(state: &AppState) -> HashSet<String> {
    match state.preferences.read().enable_seventv {
        true => state.seventv_sets(),
        false => HashSet::new(),
    }
}

/// Bring the subscriptions in line with the open channels, and say whether
/// there's anything left to watch. `false` means let the socket go: holding one
/// open subscribed to nothing costs 7TV a connection and tells us nothing.
async fn resubscribe(
    state: &AppState,
    write: &mut Socket,
    subscribed: &mut HashSet<String>,
) -> Result<bool> {
    let wanted = wanted(state);

    for set in wanted.difference(subscribed) {
        write.send(frame(OP_SUBSCRIBE, set)).await?;
    }
    for set in subscribed.difference(&wanted) {
        write.send(frame(OP_UNSUBSCRIBE, set)).await?;
    }

    *subscribed = wanted;
    Ok(!subscribed.is_empty())
}

/// One connection, from the welcome to whatever ends it.
async fn connect_once(app: &AppHandle, state: &Arc<AppState>, sink: &MessageSink) -> Result<()> {
    let (stream, _) = connect_async(WS_URL).await?;
    let (mut write, mut read) = stream.split();
    // Cleared with the socket: a new session knows nothing about what the last
    // one had asked for, so everything wanted is subscribed again on its Hello.
    let mut subscribed: HashSet<String> = HashSet::new();
    // Until the welcome lands there's no session for a subscription to attach
    // to, and a channel joined in that window needs no separate frame anyway:
    // the Hello reads what's wanted as of then.
    let mut welcomed = false;

    loop {
        tokio::select! {
            _ = state.seventv_events.notified() => {
                if welcomed && !resubscribe(state, &mut write, &mut subscribed).await? {
                    return Ok(());
                }
            }
            incoming = read.next() => {
                let Some(frame) = incoming else { return Ok(()) };
                match frame? {
                    Message::Text(text) => match classify(&text) {
                        Incoming::Hello => {
                            welcomed = true;
                            if !resubscribe(state, &mut write, &mut subscribed).await? {
                                return Ok(());
                            }
                        }
                        Incoming::Update(update) => handle(app, state, sink, &update),
                        Incoming::Restart => return Ok(()),
                        Incoming::Ignored => {}
                    },
                    Message::Ping(payload) => write.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

/// Keep the socket up for as long as there's a set worth watching.
///
/// Signed out changes nothing here -- 7TV asks who nobody is -- but 7TV
/// switched off, or no channel with a 7TV account open, means there is simply
/// nothing to subscribe to, and this waits rather than holding an idle socket.
pub async fn run(app: AppHandle, state: Arc<AppState>, sink: MessageSink) {
    let mut backoff_secs = 1u64;

    loop {
        // `notify_one` leaves a permit when nobody is waiting, so a channel
        // joined between the check and the await still wakes this.
        while wanted(&state).is_empty() {
            state.seventv_events.notified().await;
        }

        match connect_once(&app, &state, &sink).await {
            Ok(()) => backoff_secs = 1,
            Err(error) => log::warn!("7tv event socket: {error}"),
        }

        let jitter = rand::thread_rng().gen_range(0..500);
        tokio::time::sleep(Duration::from_millis(backoff_secs * 1000 + jitter)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ChannelData;

    /// One set entry, in the shape 7TV pushes it.
    fn entry(id: &str, name: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{name}","flags":0,"data":{{"id":"{id}","flags":0,
               "host":{{"url":"//cdn.7tv.app/emote/{id}","files":[
                 {{"name":"2x.webp","format":"WEBP","width":64,"height":64}}]}}}}}}"#
        )
    }

    fn emote(provider: &'static str, id: &str, name: &str) -> Emote {
        Emote {
            id: id.to_string(),
            name: name.to_string(),
            url: String::new(),
            url_large: String::new(),
            provider,
            zero_width: false,
            width: 64,
            height: 64,
        }
    }

    #[test]
    fn an_added_emote_arrives_renderable() {
        let raw = format!(
            r#"{{"op":0,"d":{{"type":"emote_set.update","body":{{"id":"set-1",
               "actor":{{"display_name":"NymN"}},
               "pushed":[{{"key":"emotes","index":0,"value":{}}}]}}}}}}"#,
            entry("abc", "catJAM")
        );
        let Incoming::Update(update) = classify(&raw) else {
            panic!("expected an update")
        };

        assert_eq!(update.set, "set-1");
        assert_eq!(update.actor, "NymN");
        assert_eq!(update.added.len(), 1);
        assert_eq!(update.added[0].name, "catJAM");
        assert_eq!(update.added[0].url, "https://cdn.7tv.app/emote/abc/2x.webp");
        assert_eq!(lines(&update), vec!["7TV: NymN added catJAM"]);
    }

    #[test]
    fn a_removed_emote_is_read_off_the_old_value() {
        let raw = r#"{"op":0,"d":{"type":"emote_set.update","body":{"id":"set-1",
            "actor":{"display_name":"NymN"},
            "pulled":[{"key":"emotes","index":0,"old_value":{"id":"abc","name":"catJAM"}}]}}}"#;
        let Incoming::Update(update) = classify(raw) else {
            panic!("expected an update")
        };

        assert_eq!(
            update.removed,
            vec![NamedEmote {
                id: "abc".into(),
                name: "catJAM".into()
            }]
        );
        assert_eq!(lines(&update), vec!["7TV: NymN removed catJAM"]);
    }

    #[test]
    fn a_rename_carries_both_names() {
        let raw = r#"{"op":0,"d":{"type":"emote_set.update","body":{"id":"set-1",
            "updated":[{"key":"emotes","index":0,
              "old_value":{"id":"abc","name":"catJAM"},"value":{"id":"abc","name":"catJam"}}]}}}"#;
        let Incoming::Update(update) = classify(raw) else {
            panic!("expected an update")
        };

        assert_eq!(
            update.renamed,
            vec![Rename {
                id: "abc".into(),
                from: "catJAM".into(),
                to: "catJam".into()
            }]
        );
        // No actor in that dispatch, so the line keeps the verb and drops the
        // subject rather than reading as though nobody did it.
        assert_eq!(lines(&update), vec!["7TV: renamed catJAM to catJam"]);
    }

    #[test]
    fn changes_to_anything_but_the_emotes_are_ignored() {
        // Renaming the set itself is an update to the same object, and says
        // nothing about what a chatter can type.
        let raw = r#"{"op":0,"d":{"type":"emote_set.update","body":{"id":"set-1",
            "updated":[{"key":"name","old_value":"old","value":"new"}]}}}"#;
        assert_eq!(classify(raw), Incoming::Ignored);
    }

    #[test]
    fn other_frames_are_read_for_what_they_are() {
        assert_eq!(
            classify(r#"{"op":1,"d":{"session_id":"x"}}"#),
            Incoming::Hello
        );
        assert_eq!(classify(r#"{"op":2,"d":{"count":3}}"#), Incoming::Ignored);
        assert_eq!(classify(r#"{"op":4,"d":{}}"#), Incoming::Restart);
        assert_eq!(classify(r#"{"op":7,"d":{"code":4000}}"#), Incoming::Restart);
        assert_eq!(
            classify(r#"{"op":0,"d":{"type":"cosmetic.create"}}"#),
            Incoming::Ignored
        );
        assert_eq!(classify("not json at all"), Incoming::Ignored);
    }

    #[test]
    fn removing_a_seventv_emote_uncovers_the_name_it_was_shadowing() {
        let others = HashMap::from([("KEKW".to_string(), emote("bttv", "b-1", "KEKW"))]);
        let mut merged = HashMap::from([
            ("KEKW".to_string(), emote("7tv", "s-1", "KEKW")),
            ("catJAM".to_string(), emote("7tv", "s-2", "catJAM")),
        ]);

        assert!(uncover(&mut merged, &others, "KEKW", "s-1"));
        assert_eq!(
            merged["KEKW"].provider, "bttv",
            "BTTV's was there all along"
        );

        assert!(uncover(&mut merged, &others, "catJAM", "s-2"));
        assert!(
            !merged.contains_key("catJAM"),
            "nothing underneath, so the name goes"
        );
    }

    #[test]
    fn a_removal_naming_another_emote_leaves_the_name_alone() {
        // The set removed an emote whose alias we're holding for a *different*
        // one -- a stale dispatch, or another provider's name.
        let others = HashMap::new();
        let mut merged = HashMap::from([("KEKW".to_string(), emote("7tv", "s-1", "KEKW"))]);

        assert!(!uncover(&mut merged, &others, "KEKW", "s-9"));
        assert_eq!(merged["KEKW"].id, "s-1");
    }

    #[test]
    fn a_long_list_stops_naming_them_all() {
        assert_eq!(listed(&["a"]), "a");
        assert_eq!(listed(&["a", "b"]), "a and b");
        assert_eq!(listed(&["a", "b", "c"]), "a, b and c");
        assert_eq!(
            listed(&["a", "b", "c", "d", "e", "f", "g"]),
            "a, b, c, d, e and 2 more"
        );
    }

    #[test]
    fn an_update_moves_every_channel_on_that_set_and_nobody_else() {
        let state = AppState::new();
        {
            let mut data = state.data.write();
            data.insert(
                "forsen".to_string(),
                ChannelData {
                    seventv_set: Some("set-1".to_string()),
                    emotes: HashMap::from([
                        ("KEKW".to_string(), emote("7tv", "s-1", "KEKW")),
                        ("Pepega".to_string(), emote("7tv", "s-2", "Pepega")),
                    ]),
                    other_emotes: HashMap::from([(
                        "KEKW".to_string(),
                        emote("bttv", "b-1", "KEKW"),
                    )]),
                    ..ChannelData::default()
                },
            );
            // Someone else's room, on a set nothing here is watching.
            data.insert(
                "nymn".to_string(),
                ChannelData {
                    seventv_set: Some("set-2".to_string()),
                    emotes: HashMap::from([("KEKW".to_string(), emote("7tv", "s-1", "KEKW"))]),
                    ..ChannelData::default()
                },
            );
        }

        let update = SetUpdate {
            set: "set-1".to_string(),
            actor: "NymN".to_string(),
            added: vec![emote("7tv", "s-3", "catJAM")],
            removed: vec![NamedEmote {
                id: "s-1".into(),
                name: "KEKW".into(),
            }],
            renamed: vec![Rename {
                id: "s-2".into(),
                from: "Pepega".into(),
                to: "Pepege".into(),
            }],
        };
        assert_eq!(apply(&state, &update), vec!["forsen".to_string()]);

        let data = state.data.read();
        let moved = &data["forsen"].emotes;
        assert_eq!(
            moved["catJAM"].id, "s-3",
            "the added emote renders straight away"
        );
        assert_eq!(
            moved["KEKW"].provider, "bttv",
            "BTTV's was under the one removed"
        );
        assert!(!moved.contains_key("Pepega"), "the old alias stops working");
        assert_eq!(
            moved["Pepege"].id, "s-2",
            "and the new one is the same image"
        );
        assert_eq!(
            data["forsen"].emote_revision, 1,
            "the event invalidates an older whole-set refresh"
        );

        assert_eq!(
            data["nymn"].emotes["KEKW"].provider, "7tv",
            "another set is untouched"
        );
    }

    #[test]
    fn a_pile_of_renames_is_one_line() {
        let update = SetUpdate {
            set: "set-1".into(),
            actor: "NymN".into(),
            renamed: (0..8)
                .map(|n| Rename {
                    id: format!("id-{n}"),
                    from: format!("a{n}"),
                    to: format!("b{n}"),
                })
                .collect(),
            ..SetUpdate::default()
        };
        assert_eq!(lines(&update), vec!["7TV: NymN renamed 8 emotes"]);
    }
}
