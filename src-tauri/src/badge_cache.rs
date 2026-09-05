//! Persistent badge definitions and per-chatter 7TV assignments.
//!
//! Badge images share the bounded on-disk image cache with emotes. This file
//! stores the smaller piece needed to find those images again: Twitch's global
//! and channel definitions, plus short-lived positive and negative 7TV user
//! answers. Twitch snapshots are always refreshed when credentials exist; 7TV
//! answers expire so a changed or removed equipped badge cannot live forever.

use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::twitch::badges::{Badge, BadgeMap};

const VERSION: u32 = 1;
const MAX_CHANNELS: usize = 128;
const MAX_SEVENTV_USERS: usize = 20_000;
const SEVENTV_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTwitchBadge {
    set_id: String,
    version: String,
    badge: Badge,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoredChannel {
    updated_at: u64,
    badges: Vec<StoredTwitchBadge>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoredSevenTvBadge {
    updated_at: u64,
    /// `None` is a successful lookup: the user has no equipped badge.
    badge: Option<Badge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Snapshot {
    version: u32,
    /// `None` means Twitch has never answered successfully; `Some(empty)` is
    /// a real empty result and must replace any older definitions.
    global: Option<Vec<StoredTwitchBadge>>,
    channels: HashMap<String, StoredChannel>,
    seventv: HashMap<String, StoredSevenTvBadge>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: VERSION,
            global: None,
            channels: HashMap::new(),
            seventv: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CachedSevenTvBadge {
    Fresh(Option<Badge>),
    Stale(Option<Badge>),
    Missing,
}

#[derive(Debug, Default)]
pub struct BadgeCache {
    snapshot: Mutex<Snapshot>,
}

impl BadgeCache {
    pub fn initialize(&self, app: &AppHandle) {
        let Ok(file) = path(app) else {
            return;
        };
        *self.snapshot.lock() = load_from(&file);
    }

    pub fn global(&self) -> Option<BadgeMap> {
        self.snapshot
            .lock()
            .global
            .as_ref()
            .map(|badges| decode_twitch(badges.clone()))
    }

    pub fn channel(&self, room_id: &str) -> Option<BadgeMap> {
        self.snapshot
            .lock()
            .channels
            .get(room_id)
            .map(|channel| decode_twitch(channel.badges.clone()))
    }

    pub fn seventv(&self, user_id: &str) -> CachedSevenTvBadge {
        let snapshot = self.snapshot.lock();
        let Some(answer) = snapshot.seventv.get(user_id) else {
            return CachedSevenTvBadge::Missing;
        };
        let badge = answer.badge.clone();
        if now_secs().saturating_sub(answer.updated_at) <= SEVENTV_TTL_SECS {
            CachedSevenTvBadge::Fresh(badge)
        } else {
            CachedSevenTvBadge::Stale(badge)
        }
    }

    pub fn store_global(&self, app: &AppHandle, badges: &BadgeMap) {
        let mut snapshot = self.snapshot.lock();
        snapshot.global = Some(encode_twitch(badges));
        save(app, &snapshot, "global Twitch badge");
    }

    pub fn store_channel(&self, app: &AppHandle, room_id: &str, badges: &BadgeMap) {
        let mut snapshot = self.snapshot.lock();
        snapshot.channels.insert(
            room_id.to_string(),
            StoredChannel {
                updated_at: now_secs(),
                badges: encode_twitch(badges),
            },
        );
        trim_by_recency(&mut snapshot.channels, MAX_CHANNELS, |value| {
            value.updated_at
        });
        save(app, &snapshot, "channel Twitch badge");
    }

    pub fn store_seventv(&self, app: &AppHandle, answers: &HashMap<String, Option<Badge>>) {
        if answers.is_empty() {
            return;
        }
        let mut snapshot = self.snapshot.lock();
        let updated_at = now_secs();
        for (user_id, badge) in answers {
            snapshot.seventv.insert(
                user_id.clone(),
                StoredSevenTvBadge {
                    updated_at,
                    badge: badge.clone(),
                },
            );
        }
        trim_by_recency(&mut snapshot.seventv, MAX_SEVENTV_USERS, |value| {
            value.updated_at
        });
        save(app, &snapshot, "7TV badge");
    }

    /// Resolve a badge image key from trusted provider metadata. The webview
    /// supplies only the opaque key; it never gets to choose a download URL.
    pub fn image_url(&self, key: &str) -> Option<String> {
        let snapshot = self.snapshot.lock();
        let badges = snapshot
            .global
            .iter()
            .flatten()
            .map(|stored| &stored.badge)
            .chain(
                snapshot
                    .channels
                    .values()
                    .flat_map(|channel| channel.badges.iter().map(|stored| &stored.badge)),
            )
            .chain(
                snapshot
                    .seventv
                    .values()
                    .filter_map(|answer| answer.badge.as_ref()),
            );
        badges
            .filter(|badge| badge.cache_key == key)
            .find_map(|badge| trusted_image_url(&badge.url).then(|| badge.url.clone()))
    }
}

fn encode_twitch(badges: &BadgeMap) -> Vec<StoredTwitchBadge> {
    badges
        .iter()
        .map(|((set_id, version), badge)| StoredTwitchBadge {
            set_id: set_id.clone(),
            version: version.clone(),
            badge: badge.clone(),
        })
        .collect()
}

fn decode_twitch(badges: Vec<StoredTwitchBadge>) -> BadgeMap {
    badges
        .into_iter()
        .map(|stored| ((stored.set_id, stored.version), stored.badge))
        .collect()
}

fn trusted_image_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(url.host_str(), Some("static-cdn.jtvnw.net" | "cdn.7tv.app"))
}

fn trim_by_recency<T>(values: &mut HashMap<String, T>, max: usize, updated_at: impl Fn(&T) -> u64) {
    if values.len() <= max {
        return;
    }
    let mut oldest: Vec<(String, u64)> = values
        .iter()
        .map(|(id, value)| (id.clone(), updated_at(value)))
        .collect();
    oldest.sort_by_key(|(_, timestamp)| *timestamp);
    for (id, _) in oldest.into_iter().take(values.len() - max) {
        values.remove(&id);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_cache_dir()?.join("badge-catalogs.json"))
}

fn save(app: &AppHandle, snapshot: &Snapshot, label: &str) {
    let result = path(app).and_then(|file| save_to(&file, snapshot));
    if let Err(error) = result {
        log::warn!("could not save {label} cache: {error}");
    }
}

fn load_from(file: &Path) -> Snapshot {
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Snapshot::default();
    };
    match serde_json::from_str::<Snapshot>(&raw) {
        Ok(snapshot) if snapshot.version == VERSION => snapshot,
        Ok(_) => Snapshot::default(),
        Err(error) => {
            log::warn!("ignoring malformed badge catalog cache: {error}");
            Snapshot::default()
        }
    }
}

fn save_to(file: &Path, snapshot: &Snapshot) -> Result<()> {
    let dir = file.parent().expect("badge cache path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".badge-catalogs-")
        .tempfile_in(dir)?;
    temporary.write_all(serde_json::to_vec(snapshot)?.as_slice())?;
    temporary.persist(file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn badge(provider: &str, id: &str, url: &str) -> Badge {
        Badge::new(
            provider,
            id.to_string(),
            "Badge".to_string(),
            url.to_string(),
        )
    }

    #[test]
    fn snapshot_round_trips_positive_and_negative_answers() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("badge-catalogs.json");
        let mut snapshot = Snapshot {
            global: Some(encode_twitch(&HashMap::from([(
                ("moderator".to_string(), "1".to_string()),
                badge(
                    "twitch",
                    "moderator/1",
                    "https://static-cdn.jtvnw.net/badges/v1/mod/3",
                ),
            )]))),
            ..Default::default()
        };
        snapshot.seventv.insert(
            "123".to_string(),
            StoredSevenTvBadge {
                updated_at: now_secs(),
                badge: None,
            },
        );

        save_to(&file, &snapshot).unwrap();
        let loaded = load_from(&file);
        assert_eq!(loaded.global.unwrap().len(), 1);
        assert!(loaded.seventv.get("123").unwrap().badge.is_none());
    }

    #[test]
    fn only_provider_badge_cdns_are_downloadable() {
        assert!(trusted_image_url(
            "https://static-cdn.jtvnw.net/badges/v1/mod/3"
        ));
        assert!(trusted_image_url("https://cdn.7tv.app/badge/id/2x.webp"));
        assert!(!trusted_image_url("http://cdn.7tv.app/badge/id/2x.webp"));
        assert!(!trusted_image_url("https://example.com/tracker.png"));
    }

    #[test]
    fn seven_tv_answers_expire_without_being_discarded() {
        let fresh_badge = badge("7tv", "one", "https://cdn.7tv.app/badge/one/2x.webp");
        let stale_badge = badge("7tv", "two", "https://cdn.7tv.app/badge/two/2x.webp");
        let cache = BadgeCache {
            snapshot: Mutex::new(Snapshot {
                seventv: HashMap::from([
                    (
                        "fresh".to_string(),
                        StoredSevenTvBadge {
                            updated_at: now_secs(),
                            badge: Some(fresh_badge.clone()),
                        },
                    ),
                    (
                        "stale".to_string(),
                        StoredSevenTvBadge {
                            updated_at: now_secs().saturating_sub(SEVENTV_TTL_SECS + 1),
                            badge: Some(stale_badge.clone()),
                        },
                    ),
                ]),
                ..Default::default()
            }),
        };

        assert_eq!(
            cache.seventv("fresh"),
            CachedSevenTvBadge::Fresh(Some(fresh_badge))
        );
        assert_eq!(
            cache.seventv("stale"),
            CachedSevenTvBadge::Stale(Some(stale_badge))
        );
        assert_eq!(cache.seventv("missing"), CachedSevenTvBadge::Missing);
    }

    #[test]
    fn image_keys_resolve_only_through_trusted_cached_metadata() {
        let good = badge("7tv", "good", "https://cdn.7tv.app/badge/good/2x.webp");
        let bad = badge("7tv", "bad", "https://example.com/tracker.png");
        let cache = BadgeCache {
            snapshot: Mutex::new(Snapshot {
                seventv: HashMap::from([
                    (
                        "1".to_string(),
                        StoredSevenTvBadge {
                            updated_at: now_secs(),
                            badge: Some(good.clone()),
                        },
                    ),
                    (
                        "2".to_string(),
                        StoredSevenTvBadge {
                            updated_at: now_secs(),
                            badge: Some(bad.clone()),
                        },
                    ),
                ]),
                ..Default::default()
            }),
        };

        assert_eq!(cache.image_url(&good.cache_key), Some(good.url));
        assert_eq!(cache.image_url(&bad.cache_key), None);
    }

    #[test]
    fn caches_are_bounded_by_oldest_update() {
        let mut values = HashMap::new();
        for timestamp in 0..=MAX_CHANNELS {
            values.insert(
                timestamp.to_string(),
                StoredChannel {
                    updated_at: timestamp as u64,
                    ..Default::default()
                },
            );
        }
        trim_by_recency(&mut values, MAX_CHANNELS, |value| value.updated_at);
        assert_eq!(values.len(), MAX_CHANNELS);
        assert!(!values.contains_key("0"));
    }
}
