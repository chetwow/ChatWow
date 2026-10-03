# Media and previews

[Architecture map](../../ARCHITECTURE.md)

Sources: [linkinfo.rs](../../src-tauri/src/linkinfo.rs), [links.ts](../../src/lib/links.ts),
[linkPreviews.ts](../../src/lib/linkPreviews.ts), [HoverPreview.tsx](../../src/components/HoverPreview.tsx),
[inlineVideo.ts](../../src/store/inlineVideo.ts), [usercard.rs](../../src-tauri/src/usercard.rs).

## Network boundary

Classify links locally before any request. Image extensions and 7TV emote pages use the image
preview preference; other pages, including YouTube/Twitch, use the page preference. Disabled
classes must avoid the IPC call. Direct images and page thumbnails are fetched through Rust's
protected path and returned as bounded blob images; the webview does not directly fetch arbitrary
chatter-selected image hosts.

The protected client is separate from `AppState::http`. At each redirect hop it resolves the
hostname, rejects the entire answer if any address is non-public, pins the request to validated
addresses, and disables proxies. This protects against private-network requests and DNS rebinding.
Requests have eight-second bounds and at most five redirects. Body limits are 256 KB for ordinary
pages, 1 MB for recognized YouTube pages, and 8 MB for images. Resolve thumbnail URLs against the
final page URL, then apply the same protected fetch. Keep new fetch paths inside this boundary.

Generic page previews scan OpenGraph, Twitter, and title metadata. YouTube additionally extracts
duration/channel/count fields. Twitch clip/VOD/channel links prefer Helix when a token is available,
then fall back to generic pages. 7TV emote pages resolve through their provider API and use the
emote-style preview. Missing optional metadata is omitted. Preview TTL zero means session lifetime;
live Twitch channels use a short TTL. Session caches are bounded and cache misses as well as hits.

One shared preview store prevents overlapping emote/link popups. The fetch delay avoids requests
from incidental pointer crossings. Once visible, keep the card anchored through chat movement:
synthetic mouseleave from a scrolling link must not dismiss it. Real pointer movement, Escape,
the movement corridor, and jitter tolerance govern dismissal. Advance the preview generation on
dismissal so an old fetch cannot resurrect it. Measure/reclamp after images load.

## Inline media

Images, YouTube, and Twitch clips have independent, default-off opt-ins separate from hover
previews. Only one inline video is expanded per webview/window across providers, panes, and logs.
The owner is a link-instance symbol plus tab ID, not a URL. All cleanup/visibility reports must
check ownership so a previous player's unmount cannot close its replacement.

`keepVideoPlayersOffscreen` and `keepVideoPlayersInactive` retain positive persistence semantics;
the UI's "Close ..." controls invert them. Visible split panes count as active. If inactive-player
retention is enabled, `Panes` keeps only the owning hidden tab mounted and disables its typing,
search, and scroll-visibility checks. Closing its tab or opening another video still unmounts it.
An off-screen retained player exposes a floating close control in its owning chat.

YouTube loads the IFrame API only after a click and destroys it on close/disable/unmount.
Errors and load timeouts offer the original URL in a browser. Twitch supports clips only, uses
the current hostname as `parent`, and scales its minimum-size iframe in narrow panes without
reloading it. Iframe load is not proof of playback: cross-origin provider errors cannot be read.
Both providers disable autoplay/fullscreen where supported and retain a browser action. Opening
the browser successfully closes video; an opener failure preserves it and reports an error.
Packaged embeds depend on the [loopback origin](windows.md#native-presentation-and-packaged-origin).

Inline images reuse the protected image fetch but have local expansion state: multiple images
can remain open and are independent of video ownership. Only recognized direct image links
qualify. Opening an image in the browser leaves its card open; disabling images or unmounting
the row removes it.

## User cards

[UserCard.tsx](../../src/components/UserCard.tsx) takes its channel from the clicked message,
including in listener views. Its transcript deduplicates retained channel messages from all tabs
by ID and sorts chronologically. Listener actions reuse the chatter listener's one-time live
backfill and notifications-off defaults.

Helix supplies profile data with any available account; ivr.fi provides fallback identity and
follow/subscription history. An unavailable history result must display "Unavailable", never
"not following/subscribed". Current subscription metadata, cumulative months, and hidden status
are separate states. Validate logins before inserting them into URL paths. Cache by channel/login
for the session and remount when the selected login changes. Clamp the card to the window and
shrink its scrollable transcript at minimum window size.
