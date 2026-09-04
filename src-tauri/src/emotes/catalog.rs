//! Persistent snapshots of the emote catalogs returned by 7TV, BTTV and FFZ.
//!
//! Images have their own cache in [`super::cache`]. This is the smaller half:
//! the names, ids and URLs needed to resolve a message before provider APIs
//! answer on launch or when a channel is revisited. A snapshot is always
//! followed by a network refresh, so it is a starting point rather than a
//! second source of truth.

use anyhow::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use super::{merge, Emote, Providers};

const VERSION: u32 = 1;
const MAX_CHANNELS: usize = 128;

#[derive(Debug, Clone, Default)]
pub struct SevenTvSet {
    pub id: Option<String>,
    pub emotes: HashMap<String, Emote>,
}

/// Provider results keep `None` distinct from an empty set: `None` means the
/// provider was disabled or failed, while `Some(empty)` is a successful answer
/// saying that provider has no emotes here.
#[derive(Debug, Clone, Default)]
pub struct ProviderSets {
    pub ffz: Option<HashMap<String, Emote>>,
    pub bttv: Option<HashMap<String, Emote>>,
    pub seventv: Option<SevenTvSet>,
}

impl ProviderSets {
    pub fn with_fallback(mut self, cached: Self) -> Self {
        if self.ffz.is_none() {
            self.ffz = cached.ffz;
        }
        if self.bttv.is_none() {
            self.bttv = cached.bttv;
        }
        if self.seventv.is_none() {
            self.seventv = cached.seventv;
        }
        self
    }

    pub fn complete_for(&self, providers: Providers) -> bool {
        (!providers.ffz || self.ffz.is_some())
            && (!providers.bttv || self.bttv.is_some())
            && (!providers.seventv || self.seventv.is_some())
    }

    pub fn global_map(self, providers: Providers) -> HashMap<String, Emote> {
        merge(vec![
            enabled_map(providers.ffz, self.ffz),
            enabled_map(providers.bttv, self.bttv),
            enabled_map(providers.seventv, self.seventv.map(|set| set.emotes)),
        ])
    }

    /// The merged room map, its FFZ+BTTV underlay, and the 7TV set id to watch.
    pub fn channel_parts(
        self,
        providers: Providers,
    ) -> (
        HashMap<String, Emote>,
        HashMap<String, Emote>,
        Option<String>,
    ) {
        let ffz = enabled_map(providers.ffz, self.ffz);
        let bttv = enabled_map(providers.bttv, self.bttv);
        let seventv = match (providers.seventv, self.seventv) {
            (true, Some(set)) => set,
            _ => SevenTvSet::default(),
        };
        let others = merge(vec![ffz, bttv]);
        (
            merge(vec![others.clone(), seventv.emotes]),
            others,
            seventv.id,
        )
    }

    fn has_result(&self) -> bool {
        self.ffz.is_some() || self.bttv.is_some() || self.seventv.is_some()
    }
}

fn enabled_map(enabled: bool, map: Option<HashMap<String, Emote>>) -> HashMap<String, Emote> {
    if enabled {
        map.unwrap_or_default()
    } else {
        HashMap::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEmote {
    id: String,
    name: String,
    url: String,
    url_large: String,
    zero_width: bool,
    width: u32,
    height: u32,
}

impl StoredEmote {
    fn from_emote(emote: &Emote) -> Self {
        Self {
            id: emote.id.clone(),
            name: emote.name.clone(),
            url: emote.url.clone(),
            url_large: emote.url_large.clone(),
            zero_width: emote.zero_width,
            width: emote.width,
            height: emote.height,
        }
    }

    fn into_emote(self, provider: &'static str) -> Emote {
        Emote {
            id: self.id,
            name: self.name,
            url: self.url,
            url_large: self.url_large,
            provider,
            zero_width: self.zero_width,
            width: self.width,
            height: self.height,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoredSevenTvSet {
    id: Option<String>,
    emotes: Vec<StoredEmote>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoredProviders {
    ffz: Option<Vec<StoredEmote>>,
    bttv: Option<Vec<StoredEmote>>,
    seventv: Option<StoredSevenTvSet>,
}

impl StoredProviders {
    fn decoded(&self) -> ProviderSets {
        ProviderSets {
            ffz: self.ffz.clone().map(|items| decode(items, "ffz")),
            bttv: self.bttv.clone().map(|items| decode(items, "bttv")),
            seventv: self.seventv.clone().map(|set| SevenTvSet {
                id: set.id,
                emotes: decode(set.emotes, "7tv"),
            }),
        }
    }

    fn update(&mut self, fresh: &ProviderSets) {
        if let Some(emotes) = fresh.ffz.as_ref() {
            self.ffz = Some(encode(emotes));
        }
        if let Some(emotes) = fresh.bttv.as_ref() {
            self.bttv = Some(encode(emotes));
        }
        if let Some(set) = fresh.seventv.as_ref() {
            self.seventv = Some(StoredSevenTvSet {
                id: set.id.clone(),
                emotes: encode(&set.emotes),
            });
        }
    }
}

fn encode(emotes: &HashMap<String, Emote>) -> Vec<StoredEmote> {
    emotes.values().map(StoredEmote::from_emote).collect()
}

fn decode(items: Vec<StoredEmote>, provider: &'static str) -> HashMap<String, Emote> {
    items
        .into_iter()
        .map(|item| {
            let emote = item.into_emote(provider);
            (emote.name.clone(), emote)
        })
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoredChannel {
    updated_at: u64,
    providers: StoredProviders,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Snapshot {
    version: u32,
    global: StoredProviders,
    channels: HashMap<String, StoredChannel>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: VERSION,
            global: StoredProviders::default(),
            channels: HashMap::new(),
        }
    }
}

/// Loaded once into memory; writes are serialized and atomically replace the
/// disk snapshot so simultaneous provider refreshes cannot lose each other.
#[derive(Debug, Default)]
pub struct CatalogCache {
    snapshot: Mutex<Snapshot>,
}

impl CatalogCache {
    pub fn initialize(&self, app: &AppHandle) {
        let Ok(file) = path(app) else {
            return;
        };
        *self.snapshot.lock() = load_from(&file);
    }

    pub fn global(&self) -> ProviderSets {
        self.snapshot.lock().global.decoded()
    }

    pub fn channel(&self, room_id: &str) -> Option<ProviderSets> {
        self.snapshot
            .lock()
            .channels
            .get(room_id)
            .map(|channel| channel.providers.decoded())
    }

    pub fn store_global(&self, app: &AppHandle, fresh: &ProviderSets) {
        if !fresh.has_result() {
            return;
        }
        let mut snapshot = self.snapshot.lock();
        snapshot.global.update(fresh);
        let result = path(app).and_then(|file| save_to(&file, &snapshot));
        if let Err(error) = result {
            log::warn!("could not save global emote catalog cache: {error}");
        }
    }

    pub fn store_channel(&self, app: &AppHandle, room_id: &str, fresh: &ProviderSets) {
        if !fresh.has_result() {
            return;
        }
        let mut snapshot = self.snapshot.lock();
        let channel = snapshot.channels.entry(room_id.to_string()).or_default();
        channel.updated_at = now_secs();
        channel.providers.update(fresh);
        trim_channels(&mut snapshot.channels);
        let result = path(app).and_then(|file| save_to(&file, &snapshot));
        if let Err(error) = result {
            log::warn!("could not save channel emote catalog cache: {error}");
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn trim_channels(channels: &mut HashMap<String, StoredChannel>) {
    if channels.len() <= MAX_CHANNELS {
        return;
    }
    let mut oldest: Vec<(String, u64)> = channels
        .iter()
        .map(|(id, channel)| (id.clone(), channel.updated_at))
        .collect();
    oldest.sort_by_key(|(_, updated_at)| *updated_at);
    for (id, _) in oldest.into_iter().take(channels.len() - MAX_CHANNELS) {
        channels.remove(&id);
    }
}

fn path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_cache_dir()?.join("emote-catalogs.json"))
}

fn load_from(file: &Path) -> Snapshot {
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Snapshot::default();
    };
    match serde_json::from_str::<Snapshot>(&raw) {
        Ok(snapshot) if snapshot.version == VERSION => snapshot,
        Ok(_) => Snapshot::default(),
        Err(error) => {
            log::warn!("ignoring malformed emote catalog cache: {error}");
            Snapshot::default()
        }
    }
}

fn save_to(file: &Path, snapshot: &Snapshot) -> Result<()> {
    let dir = file.parent().expect("catalog cache path has a parent");
    std::fs::create_dir_all(dir)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".emote-catalogs-")
        .tempfile_in(dir)?;
    temporary.write_all(serde_json::to_vec(snapshot)?.as_slice())?;
    temporary.persist(file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emote(provider: &'static str, name: &str) -> Emote {
        Emote {
            id: format!("{provider}-{name}"),
            name: name.to_string(),
            url: format!("https://example.com/{name}/2x"),
            url_large: format!("https://example.com/{name}/4x"),
            provider,
            zero_width: false,
            width: 28,
            height: 28,
        }
    }

    #[test]
    fn stored_emotes_recover_their_static_provider() {
        let original = HashMap::from([("Clap".to_string(), emote("7tv", "Clap"))]);
        let decoded = decode(encode(&original), "7tv");
        assert_eq!(decoded, original);
    }

    #[test]
    fn fresh_provider_results_only_replace_the_providers_that_answered() {
        let mut stored = StoredProviders {
            ffz: Some(encode(&HashMap::from([(
                "OldFfz".to_string(),
                emote("ffz", "OldFfz"),
            )]))),
            bttv: Some(Vec::new()),
            seventv: None,
        };
        stored.update(&ProviderSets {
            ffz: None,
            bttv: Some(HashMap::from([(
                "NewBttv".to_string(),
                emote("bttv", "NewBttv"),
            )])),
            seventv: None,
        });

        let decoded = stored.decoded();
        assert!(decoded.ffz.unwrap().contains_key("OldFfz"));
        assert!(decoded.bttv.unwrap().contains_key("NewBttv"));
    }

    #[test]
    fn channel_catalog_is_bounded_by_recency() {
        let mut channels = HashMap::new();
        for updated_at in 0..=MAX_CHANNELS {
            channels.insert(
                updated_at.to_string(),
                StoredChannel {
                    updated_at: updated_at as u64,
                    ..Default::default()
                },
            );
        }
        trim_channels(&mut channels);
        assert_eq!(channels.len(), MAX_CHANNELS);
        assert!(!channels.contains_key("0"));
    }

    #[test]
    fn snapshot_round_trips_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("emote-catalogs.json");
        let mut snapshot = Snapshot::default();
        snapshot.global.ffz = Some(encode(&HashMap::from([(
            "FeelsGoodMan".to_string(),
            emote("ffz", "FeelsGoodMan"),
        )])));

        save_to(&file, &snapshot).unwrap();
        let loaded = load_from(&file);
        assert!(loaded
            .global
            .decoded()
            .ffz
            .unwrap()
            .contains_key("FeelsGoodMan"));
    }
}
