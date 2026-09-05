//! On-disk cache of chat images, served to the webview over the `emote://`
//! scheme.
//!
//! Emotes are keyed by provider and id, never by name: 7TV emotes are routinely
//! aliased per channel, so a name is neither stable nor unique. Badges add a
//! fingerprint of the provider URL so revised art gets a fresh file.
//!
//! The cache fills lazily -- an image is downloaded the first time it's
//! actually displayed -- so joining a channel with a few thousand emotes
//! doesn't download them all. Images outside the current working set remain
//! until recency eviction is needed at 300 MB.

use anyhow::{anyhow, Result};
use filetime::FileTime;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Mutex};

/// Anything bigger than this isn't an inline chat image and shouldn't reach the disk.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
/// A hard ceiling for normal-size cached images. The active working set is
/// evicted last, but cannot make the directory grow without bound.
pub const MAX_CACHE_BYTES: u64 = 300 * 1000 * 1000;

type SharedResult = Arc<Result<(Vec<u8>, &'static str), String>>;
type Flights = HashMap<String, watch::Sender<Option<SharedResult>>>;

fn flights() -> &'static Mutex<Flights> {
    static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
struct Budget {
    total: Option<u64>,
}

fn budget() -> &'static StdMutex<Budget> {
    static BUDGET: OnceLock<StdMutex<Budget>> = OnceLock::new();
    BUDGET.get_or_init(|| StdMutex::new(Budget::default()))
}

/// Where the images live. Under the cache dir, not config: it's all
/// re-downloadable, so it's fine for the OS to clear it.
pub fn dir(app: &AppHandle) -> Result<PathBuf> {
    let path = app.path().app_cache_dir()?.join("emotes");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// Cache keys reach us straight from the webview's URL, so they're validated
/// rather than trusted -- a key is one provider and one id, nothing that could
/// climb out of the cache directory.
pub fn is_valid_key(key: &str) -> bool {
    let Some((_, id)) = split_key(key) else {
        return false;
    };
    !id.is_empty() && id.len() <= 192 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The providers whose images we serve. FFZ is deliberately absent: it splits
/// animated emotes onto their own url path, and an id alone can't say which
/// kind it is -- asking for the animated one first hangs on the emotes that
/// aren't (their CDN doesn't answer that path at all, not even a 404). Its
/// emotes go straight to the CDN url the API gave us, which is already the
/// right one; the webview's own HTTP cache is what stops the refetching.
const PROVIDERS: [&str; 5] = ["twitch-badge", "7tv-badge", "7tv", "twitch", "bttv"];

fn split_key(key: &str) -> Option<(&'static str, &str)> {
    PROVIDERS.iter().find_map(|provider| {
        key.strip_prefix(&format!("{provider}-"))
            .map(|id| (*provider, id))
    })
}

/// Where to download an emote key from. Badge URLs come from the persisted,
/// provider-authored metadata instead, because their CDN paths aren't
/// derivable from an id.
pub fn source_url(key: &str) -> Option<String> {
    if !is_valid_key(key) {
        return None;
    }
    let (provider, id) = split_key(key)?;
    match provider {
        "7tv" => Some(format!("https://cdn.7tv.app/emote/{id}/2x.webp")),
        "twitch" => Some(super::twitch_emote(id, "").url),
        // One url whatever the emote's format: BTTV serves png, gif or webp
        // from the same path, so an animated emote needs no special case.
        "bttv" => Some(format!("https://cdn.betterttv.net/emote/{id}/2x")),
        _ => None,
    }
}

/// Sniffed rather than assumed: 7TV serves webp, Twitch serves png or gif, and
/// a wrong content type on an `<img>` is a broken emote.
pub fn content_type(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ if bytes.len() > 11 && &bytes[4..8] == b"ftyp" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn read_cached(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        let _ = std::fs::remove_file(path);
        return None;
    }
    // Modification time is our portable recency index. A failed touch only
    // makes this entry look older at the next trim; it never breaks serving.
    let _ = filetime::set_file_mtime(path, FileTime::now());
    let mime = content_type(&bytes);
    if mime == "application/octet-stream" {
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some((bytes, mime))
}

async fn download(app: &AppHandle, key: &str, path: &Path) -> Result<(Vec<u8>, &'static str)> {
    let (http, active, sets_loaded, badge_url) = {
        let state = app
            .try_state::<crate::Shared>()
            .ok_or_else(|| anyhow!("app state not ready"))?;
        (
            state.http.clone(),
            state.active_cache_keys(),
            state.emote_sets_are_loaded(),
            state.badge_cache.image_url(key),
        )
    };
    let url = source_url(key)
        .or(badge_url)
        .ok_or_else(|| anyhow!("no source for {key}"))?;

    let bytes = http
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(anyhow!("{key} is too big to cache"));
    }
    let bytes = bytes.to_vec();
    let mime = content_type(&bytes);
    if mime == "application/octet-stream" {
        return Err(anyhow!("{key} didn't come back as an image"));
    }

    // Write somewhere else and rename in, so a second request for the same
    // emote can never read a half-written file.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = path.with_extension(format!("part{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let stored = if std::fs::write(&temp, &bytes).is_ok() {
        match std::fs::rename(&temp, path) {
            Ok(()) => true,
            Err(_) => {
                // Another process may have populated the same stable key.
                let _ = std::fs::remove_file(&temp);
                false
            }
        }
    } else {
        false
    };
    if stored {
        let no_active = HashSet::new();
        note_store(
            path.parent().expect("cache file has a parent"),
            bytes.len() as u64,
            if sets_loaded { &active } else { &no_active },
        );
    }

    Ok((bytes, mime))
}

/// A cached image, downloading and storing it on a miss. Concurrent misses for
/// one stable key share the leader's result instead of stampeding its CDN.
pub async fn serve(app: &AppHandle, key: &str) -> Result<(Vec<u8>, &'static str)> {
    if !is_valid_key(key) {
        return Err(anyhow!("not a cache key: {key}"));
    }

    let path = dir(app)?.join(key);
    if let Some(image) = read_cached(&path) {
        return Ok(image);
    }

    let (leader, sender, mut receiver) = {
        let mut current = flights().lock().await;
        match current.get(key) {
            Some(sender) => (false, sender.clone(), sender.subscribe()),
            None => {
                let (sender, receiver) = watch::channel(None);
                current.insert(key.to_string(), sender.clone());
                (true, sender, receiver)
            }
        }
    };

    if !leader {
        loop {
            if let Some(shared) = receiver.borrow().clone() {
                return match &*shared {
                    Ok(image) => Ok(image.clone()),
                    Err(error) => Err(anyhow!(error.clone())),
                };
            }
            match tokio::time::timeout(std::time::Duration::from_secs(20), receiver.changed()).await
            {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(anyhow!("emote download ended without a result")),
                Err(_) => {
                    let mut current = flights().lock().await;
                    if current
                        .get(key)
                        .is_some_and(|in_flight| in_flight.same_channel(&sender))
                    {
                        current.remove(key);
                    }
                    return Err(anyhow!("emote download timed out"));
                }
            }
        }
    }

    // Recheck after becoming leader: a different request may have completed
    // between the optimistic read and registration above.
    let result = match read_cached(&path) {
        Some(image) => Ok(image),
        None => download(app, key, &path).await,
    };
    let shared = Arc::new(match &result {
        Ok((bytes, mime)) => Ok((bytes.clone(), *mime)),
        Err(error) => Err(error.to_string()),
    });
    sender.send_replace(Some(shared));
    flights().lock().await.remove(key);
    result
}

#[derive(Debug)]
struct CacheFile {
    key: String,
    path: PathBuf,
    bytes: u64,
    modified: std::time::SystemTime,
}

fn cache_files(path: &Path) -> Vec<CacheFile> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let key = entry.file_name().into_string().ok()?;
            if !is_valid_key(&key) {
                // A crash can strand the atomic-write temporary. It is wholly
                // re-downloadable and must not sit outside the 300 MB budget.
                if let Some((base, suffix)) = key.rsplit_once(".part") {
                    if is_valid_key(base)
                        && !suffix.is_empty()
                        && suffix.chars().all(|c| c.is_ascii_digit())
                    {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some(CacheFile {
                key,
                path: entry.path(),
                bytes: metadata.len(),
                modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            })
        })
        .collect()
}

/// Trim least-recently-used inactive images first, then the oldest active
/// images only if the active working set itself is larger than the hard cap.
fn trim_dir(path: &Path, active: &HashSet<String>, max_bytes: u64) -> u64 {
    let mut files = cache_files(path);
    let mut total: u64 = files.iter().map(|file| file.bytes).sum();
    if total <= max_bytes {
        return total;
    }
    files.sort_by_key(|file| (active.contains(&file.key), file.modified));
    for file in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&file.path).is_ok() {
            total = total.saturating_sub(file.bytes);
        }
    }
    total
}

fn note_store(path: &Path, bytes: u64, active: &HashSet<String>) {
    let mut current = budget().lock().unwrap_or_else(|error| error.into_inner());
    let total = match current.total {
        Some(total) => total.saturating_add(bytes),
        None => cache_files(path).iter().map(|file| file.bytes).sum(),
    };
    current.total = Some(if total > MAX_CACHE_BYTES {
        trim_dir(path, active, MAX_CACHE_BYTES)
    } else {
        total
    });
}

/// Reconcile the size estimate and enforce the 300 MB ceiling. This runs off
/// the hot path whenever emote sets land; ordinary stores also enforce it.
pub fn trim(app: &AppHandle, active: &HashSet<String>) {
    let Ok(path) = dir(app) else { return };
    let mut current = budget().lock().unwrap_or_else(|error| error.into_inner());
    current.total = Some(trim_dir(&path, active, MAX_CACHE_BYTES));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_one_emote_from_a_known_provider() {
        assert!(is_valid_key("7tv-01FCY771D800007PQ2DF3GDTN6"));
        assert!(is_valid_key("twitch-25"));
        assert!(
            is_valid_key("twitch-emotesv2_a1b2"),
            "Twitch's newer id format"
        );
        assert!(is_valid_key("bttv-54fa8f1401e468494b85b537"));
        assert!(is_valid_key("twitch-badge-6d6f64657261746f722f31"));
        assert!(is_valid_key("7tv-badge-3774762d30314a4a"));
    }

    #[test]
    fn keys_that_could_escape_the_cache_directory_are_rejected() {
        assert!(!is_valid_key("7tv-../../settings.json"));
        assert!(!is_valid_key("7tv-a/b"));
        assert!(!is_valid_key("../secrets"));
        assert!(!is_valid_key("7tv-"), "a provider with no emote");
        assert!(!is_valid_key("nowhere-abc"), "provider we don't serve");
        assert!(!is_valid_key(&format!("7tv-{}", "a".repeat(193))));
    }

    #[test]
    fn source_urls_are_derived_from_the_id() {
        assert_eq!(
            source_url("7tv-abc").unwrap(),
            "https://cdn.7tv.app/emote/abc/2x.webp"
        );
        assert!(source_url("twitch-25")
            .unwrap()
            .contains("/emoticons/v2/25/"));
        assert_eq!(
            source_url("bttv-abc").unwrap(),
            "https://cdn.betterttv.net/emote/abc/2x"
        );
        assert!(source_url("twitch-badge-6d6f64").is_none());
        assert!(source_url("nonsense").is_none());
    }

    #[test]
    fn ffz_images_are_not_served_from_the_cache() {
        // Its animated emotes live on a different path, and a key carries no
        // hint which kind it is -- so FFZ emotes keep their CDN url.
        assert!(!is_valid_key("ffz-28138"));
        assert!(source_url("ffz-28138").is_none());
    }

    #[test]
    fn content_types_are_sniffed_from_the_bytes() {
        assert_eq!(content_type(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(content_type(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(content_type(b"GIF89a..."), "image/gif");
        assert_eq!(
            content_type(b"<html>not an image"),
            "application/octet-stream"
        );
    }

    #[test]
    fn trimming_keeps_recent_and_active_images_first() {
        let directory = tempfile::tempdir().unwrap();
        let old_inactive = directory.path().join("7tv-old");
        let new_inactive = directory.path().join("7tv-new");
        let active_file = directory.path().join("7tv-active");
        std::fs::write(&old_inactive, [0; 4]).unwrap();
        std::fs::write(&new_inactive, [0; 4]).unwrap();
        std::fs::write(&active_file, [0; 4]).unwrap();
        filetime::set_file_mtime(&old_inactive, FileTime::from_unix_time(1, 0)).unwrap();
        filetime::set_file_mtime(&new_inactive, FileTime::from_unix_time(2, 0)).unwrap();
        filetime::set_file_mtime(&active_file, FileTime::from_unix_time(0, 0)).unwrap();

        let active = HashSet::from(["7tv-active".to_string()]);
        assert_eq!(trim_dir(directory.path(), &active, 8), 8);
        assert!(!old_inactive.exists());
        assert!(new_inactive.exists());
        assert!(active_file.exists());
    }
}
