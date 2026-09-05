//! 7TV badges, resolved per chatter.
//!
//! There is no bulk "who has what" endpoint any more -- the v3 cosmetics route
//! that served one is gone (404), and v4 answers per user:
//!
//!   POST https://7tv.io/v4/gql   { users { userByConnection(platform: TWITCH, platformId: "…") } }
//!
//! One request per chatter would be absurd in a busy channel, so the ids are
//! batched into a single query with one alias each -- forty users in one round
//! trip. A user 7TV doesn't know, or one with no badge equipped, comes back
//! null; both are answers, and the caller remembers them so nobody is asked
//! about twice.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::badge_cache::CachedSevenTvBadge;
use crate::state::AppState;
use crate::twitch::badges::Badge;

const GQL: &str = "https://7tv.io/v4/gql";

/// How many chatters go into one query. The endpoint costs the query by
/// complexity, and forty aliases comes to a few hundred -- well inside what it
/// answers happily, while still collapsing a channel's chatters into a handful
/// of requests.
pub const BATCH: usize = 40;

/// The scale to draw at. Badges render at 18px, so the 2x image is the one
/// that stays sharp on a HiDPI display without being wasteful.
const SCALE: i64 = 2;

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    data: Option<Data>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    users: HashMap<String, Option<User>>,
}

#[derive(Deserialize)]
struct User {
    #[serde(default)]
    style: Option<Style>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Style {
    #[serde(default)]
    active_badge: Option<GqlBadge>,
}

#[derive(Deserialize)]
struct GqlBadge {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize)]
struct Image {
    #[serde(default)]
    url: String,
    #[serde(default)]
    mime: String,
    #[serde(default)]
    scale: i64,
}

/// Twitch user ids are numeric, and these go into a GraphQL document as string
/// literals -- so anything else is dropped rather than escaped. Nothing else
/// in the query is caller-supplied.
fn is_user_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit())
}

/// One aliased field per id: `u0`, `u1`, ... mapped back by position.
fn query_for(ids: &[String]) -> String {
    let fields: Vec<String> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            format!(
                "u{index}:userByConnection(platform:TWITCH,platformId:\"{id}\")\
                 {{style{{activeBadge{{id name images{{url mime scale}}}}}}}}"
            )
        })
        .collect();
    format!("{{users{{{}}}}}", fields.join(" "))
}

/// The webp at our scale, falling back to any webp and then to whatever is
/// there. A badge is a tiny image the webview has to draw inline, so format
/// matters less than having one at all.
fn pick_image(images: &[Image]) -> Option<&Image> {
    let webp = |image: &&Image| image.mime.eq_ignore_ascii_case("image/webp");
    images
        .iter()
        .find(|image| webp(image) && image.scale == SCALE)
        .or_else(|| images.iter().find(webp))
        .or_else(|| images.first())
        .filter(|image| !image.url.is_empty())
}

fn badges_from(response: Response, ids: &[String]) -> HashMap<String, Badge> {
    let Some(data) = response.data else {
        return HashMap::new();
    };
    let mut map = HashMap::new();

    for (index, id) in ids.iter().enumerate() {
        let Some(Some(user)) = data.users.get(&format!("u{index}")) else {
            continue;
        };
        let Some(badge) = user
            .style
            .as_ref()
            .and_then(|style| style.active_badge.as_ref())
        else {
            continue;
        };
        let Some(image) = pick_image(&badge.images) else {
            continue;
        };
        if badge.id.is_empty() {
            continue;
        }

        map.insert(
            id.clone(),
            Badge::new(
                "7tv",
                format!("7tv-{}", badge.id),
                badge.name.clone(),
                image.url.clone(),
            ),
        );
    }
    map
}

/// How long to let ids pile up before asking. A join hands us a hundred
/// chatters at once (the backlog alone), and this is what turns that into two
/// or three requests instead of a hundred.
const WINDOW: Duration = Duration::from_millis(400);

/// The badges for up to `BATCH` Twitch user ids, keyed by that id. Ids that
/// answered null are simply absent -- the caller treats "asked, no badge" and
/// "has a badge" alike, as answers not to repeat.
pub async fn fetch(client: &reqwest::Client, ids: &[String]) -> Result<HashMap<String, Badge>> {
    let ids: Vec<String> = ids.iter().filter(|id| is_user_id(id)).cloned().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let response = client
        .post(GQL)
        .json(&json!({ "query": query_for(&ids) }))
        .send()
        .await?
        .error_for_status()?;

    let body = response.text().await?;
    let parsed: Response = serde_json::from_str(&body)
        .map_err(|error| anyhow!("unexpected 7TV badge response: {error}"))?;
    Ok(badges_from(parsed, &ids))
}

/// The resolver: chatters go in one at a time, requests go out in batches.
///
/// Runs for the life of the app. Each answer is remembered by the caller (see
/// `AppState::queue_badge_lookup`), so a chatter is asked about once however
/// much they talk -- what reaches this queue is only ever someone new.
pub async fn run(app: AppHandle, state: Arc<AppState>, mut queue: mpsc::UnboundedReceiver<String>) {
    while let Some(first) = queue.recv().await {
        let mut batch = vec![first];
        let started = Instant::now();

        while batch.len() < BATCH {
            let Some(remaining) = WINDOW.checked_sub(started.elapsed()) else {
                break;
            };
            match timeout(remaining, queue.recv()).await {
                Ok(Some(id)) => batch.push(id),
                // The sender is gone: the app is shutting down.
                Ok(None) => return,
                Err(_) => break,
            }
        }

        let mut cached = HashMap::new();
        let mut refresh = Vec::new();
        for id in batch.into_iter().filter(|id| is_user_id(id)) {
            match state.badge_cache.seventv(&id) {
                CachedSevenTvBadge::Fresh(badge) => {
                    cached.insert(id, badge);
                }
                CachedSevenTvBadge::Stale(badge) => {
                    cached.insert(id.clone(), badge);
                    refresh.push(id);
                }
                CachedSevenTvBadge::Missing => refresh.push(id),
            }
        }

        // A stale positive answer is still useful while its refresh is in
        // flight. A cached negative explicitly removes any older frontend
        // value for the same chatter.
        apply_and_emit(&app, &state, &cached);

        if refresh.is_empty() {
            continue;
        }
        let Ok(badges) = fetch(&state.http, &refresh).await else {
            continue;
        };
        let answers: HashMap<String, Option<Badge>> = refresh
            .into_iter()
            .map(|id| {
                let badge = badges.get(&id).cloned();
                (id, badge)
            })
            .collect();

        // Serialize writes in this single resolver so a slower older snapshot
        // cannot land after a newer one. The file is cache data and small, but
        // still belongs off the async runtime thread.
        let cache_app = app.clone();
        let cache_state = Arc::clone(&state);
        let cache_answers = answers.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            cache_state
                .badge_cache
                .store_seventv(&cache_app, &cache_answers)
        })
        .await;
        apply_and_emit(&app, &state, &answers);
    }
}

fn apply_and_emit(app: &AppHandle, state: &AppState, answers: &HashMap<String, Option<Badge>>) {
    if answers.is_empty() {
        return;
    }
    {
        let mut current = state.seventv_badges.write();
        for (user_id, badge) in answers {
            match badge {
                Some(badge) => {
                    current.insert(user_id.clone(), badge.clone());
                }
                None => {
                    current.remove(user_id);
                }
            }
        }
    }
    let _ = app.emit("chat://seventv-badges", answers);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn the_query_aliases_each_id_by_position() {
        let query = query_for(&owned(&["71092938", "22484632"]));
        assert!(query.contains("u0:userByConnection(platform:TWITCH,platformId:\"71092938\")"));
        assert!(query.contains("u1:userByConnection(platform:TWITCH,platformId:\"22484632\")"));
        assert!(query.starts_with("{users{") && query.ends_with("}}"));
    }

    #[test]
    fn only_numeric_ids_reach_the_query() {
        // They're interpolated into a GraphQL document as string literals, so
        // a login or a quote would be an injection rather than a lookup.
        assert!(is_user_id("71092938"));
        assert!(!is_user_id("xqc"));
        assert!(!is_user_id("1\"){id} #"));
        assert!(!is_user_id(""));
    }

    #[test]
    fn aliases_map_back_to_the_ids_they_were_built_from() {
        let ids = owned(&["71092938", "26301881", "62300805"]);
        let json = r#"{"data":{"users":{
            "u0":{"style":{"activeBadge":{"id":"01JJ","name":"Minecraft Event Winner","images":[
              {"url":"https://cdn.7tv.app/badge/01JJ/1x_static.webp","mime":"image/webp","scale":1},
              {"url":"https://cdn.7tv.app/badge/01JJ/2x_static.webp","mime":"image/webp","scale":2}]}}},
            "u1":{"style":{"activeBadge":null}},
            "u2":{"style":{"activeBadge":{"id":"01JF","name":"NNYS Golden Gondola","images":[
              {"url":"https://cdn.7tv.app/badge/01JF/2x_static.avif","mime":"image/avif","scale":2}]}}}
        }}}"#;
        let map = badges_from(serde_json::from_str(json).unwrap(), &ids);

        let xqc = map.get("71092938").expect("the first id keeps its badge");
        assert_eq!(xqc.title, "Minecraft Event Winner");
        assert_eq!(
            xqc.url, "https://cdn.7tv.app/badge/01JJ/2x_static.webp",
            "2x webp"
        );
        assert_eq!(
            xqc.id, "7tv-01JJ",
            "namespaced, so it can't collide with a Twitch badge id"
        );

        assert!(
            !map.contains_key("26301881"),
            "a user with no badge equipped"
        );
        assert_eq!(
            map["62300805"].url, "https://cdn.7tv.app/badge/01JF/2x_static.avif",
            "no webp, so whatever is offered"
        );
    }

    #[test]
    fn a_user_7tv_doesnt_know_is_absent_rather_than_an_error() {
        let ids = owned(&["1"]);
        let json = r#"{"data":{"users":{"u0":null}}}"#;
        assert!(badges_from(serde_json::from_str(json).unwrap(), &ids).is_empty());
    }

    #[test]
    fn a_badge_with_no_image_is_skipped() {
        // Nothing to draw, and an empty src renders as a broken image.
        let ids = owned(&["5"]);
        let json = r#"{"data":{"users":{"u0":{"style":{"activeBadge":{"id":"x","name":"y","images":[]}}}}}}"#;
        assert!(badges_from(serde_json::from_str(json).unwrap(), &ids).is_empty());
    }
}
