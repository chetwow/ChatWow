//! On-disk cache of emote images, served to the webview over the `emote://`
//! scheme.
//!
//! Files are keyed by provider and emote id, never by name: 7TV emotes are
//! routinely aliased per channel, so a name is neither stable nor unique, while
//! the id survives a rename and keeps two same-named emotes apart.
//!
//! The cache fills lazily -- an emote is downloaded the first time it's
//! actually displayed, in chat or in the picker -- so joining a channel with a
//! few thousand emotes doesn't touch the network at all. Emotes that leave
//! every joined channel's set are purged by [`purge`].

use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

/// Anything bigger than this isn't an emote and shouldn't reach the disk.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

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
    let Some((_, id)) = split_key(key) else { return false };
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The providers whose images we serve. FFZ is deliberately absent: it splits
/// animated emotes onto their own url path, and an id alone can't say which
/// kind it is -- asking for the animated one first hangs on the emotes that
/// aren't (their CDN doesn't answer that path at all, not even a 404). Its
/// emotes go straight to the CDN url the API gave us, which is already the
/// right one; the webview's own HTTP cache is what stops the refetching.
const PROVIDERS: [&str; 3] = ["7tv", "twitch", "bttv"];

fn split_key(key: &str) -> Option<(&'static str, &str)> {
    PROVIDERS
        .iter()
        .find_map(|provider| key.strip_prefix(&format!("{provider}-")).map(|id| (*provider, id)))
}

/// Where to download a key from. Both providers address images by id, so the
/// url follows from the key and nothing has to be looked up or stored.
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

/// Cached files that no joined channel can reach any more.
pub fn stale(existing: Vec<String>, active: &HashSet<String>) -> Vec<String> {
    existing.into_iter().filter(|key| !active.contains(key)).collect()
}

/// A cached image, downloading and storing it on a miss.
pub async fn serve(app: &AppHandle, key: &str) -> Result<(Vec<u8>, &'static str)> {
    if !is_valid_key(key) {
        return Err(anyhow!("not an emote key: {key}"));
    }

    let path = dir(app)?.join(key);
    if let Ok(bytes) = std::fs::read(&path) {
        if !bytes.is_empty() {
            let mime = content_type(&bytes);
            return Ok((bytes, mime));
        }
    }

    let url = source_url(key).ok_or_else(|| anyhow!("no source for {key}"))?;
    let http = {
        let state = app
            .try_state::<crate::Shared>()
            .ok_or_else(|| anyhow!("app state not ready"))?;
        state.http.clone()
    };

    let bytes = http.get(url).send().await?.error_for_status()?.bytes().await?;
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
    if std::fs::write(&temp, &bytes).is_ok() && std::fs::rename(&temp, &path).is_err() {
        // Windows won't rename onto an existing file; another request beat us
        // to it, which is fine -- its bytes are the same as ours.
        let _ = std::fs::remove_file(&temp);
    }

    Ok((bytes, mime))
}

/// Delete cached images for emotes that have left every joined channel's set.
/// Cheap enough to run whenever a channel's emotes land.
pub fn purge(app: &AppHandle, active: &HashSet<String>) {
    let Ok(path) = dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&path) else { return };

    let cached: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        // Skip the temp files an in-flight download may have left behind.
        .filter(|name| is_valid_key(name))
        .collect();

    for key in stale(cached, active) {
        let _ = std::fs::remove_file(path.join(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_one_emote_from_a_known_provider() {
        assert!(is_valid_key("7tv-01FCY771D800007PQ2DF3GDTN6"));
        assert!(is_valid_key("twitch-25"));
        assert!(is_valid_key("twitch-emotesv2_a1b2"), "Twitch's newer id format");
        assert!(is_valid_key("bttv-54fa8f1401e468494b85b537"));
    }

    #[test]
    fn keys_that_could_escape_the_cache_directory_are_rejected() {
        assert!(!is_valid_key("7tv-../../settings.json"));
        assert!(!is_valid_key("7tv-a/b"));
        assert!(!is_valid_key("../secrets"));
        assert!(!is_valid_key("7tv-"), "a provider with no emote");
        assert!(!is_valid_key("nowhere-abc"), "provider we don't serve");
        assert!(!is_valid_key(&format!("7tv-{}", "a".repeat(65))));
    }

    #[test]
    fn source_urls_are_derived_from_the_id() {
        assert_eq!(source_url("7tv-abc").unwrap(), "https://cdn.7tv.app/emote/abc/2x.webp");
        assert!(source_url("twitch-25").unwrap().contains("/emoticons/v2/25/"));
        assert_eq!(source_url("bttv-abc").unwrap(), "https://cdn.betterttv.net/emote/abc/2x");
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
        assert_eq!(content_type(b"<html>not an image"), "application/octet-stream");
    }

    #[test]
    fn purging_keeps_what_is_still_reachable() {
        let active: HashSet<String> = ["7tv-keep".to_string(), "twitch-25".to_string()]
            .into_iter()
            .collect();
        let cached = vec!["7tv-keep".to_string(), "7tv-gone".to_string(), "twitch-25".to_string()];
        assert_eq!(stale(cached, &active), vec!["7tv-gone".to_string()]);
    }
}
