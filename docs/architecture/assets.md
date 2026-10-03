# Emotes and assets

[Architecture map](../../ARCHITECTURE.md)

Sources: [render.rs](../../src-tauri/src/render.rs), [emotes modules](../../src-tauri/src/emotes),
[badge_cache.rs](../../src-tauri/src/badge_cache.rs), [EmoteImage.tsx](../../src/components/EmoteImage.tsx),
[emoteComplete.ts](../../src/lib/emoteComplete.ts), [MessageRow.tsx](../../src/components/MessageRow.tsx).

## Message resolution

Twitch emote/GIF ranges are inclusive Unicode code-point positions, not byte or UTF-16 offsets.
Resolve both in Rust before IPC. Twitch emotes come from tagged occurrences, never by matching
their names in incoming text. Third-party emotes use enabled room sets before globals; provider
merge priority is 7TV, then BTTV, then FFZ. Only 7TV zero-width overlays fold onto the preceding
emote; other providers' modifier syntax is different.

GIF segments retain Twitch's exact URL, ID, and caption. Accept only HTTPS GIPHY hosts because
third-party history can supply raw IRC tags. GIFs use the webview HTTP cache. Disabling inline
GIFs renders captions and leaves image loading to the hover preview. Render-time toggles and
blacklists must repaint already-resolved immutable rows.

Gigantify marks only the last valid Twitch emote occurrence, even if the same ID occurs earlier.
Scale changes preserve overlays and original copy/reply text. Cheermotes require a positive IRC
Bits total; resolve complete tokens, choose the highest fitting tier, and never exceed the total.
Twitch emote/GIF ranges outrank cheer tokens, which outrank third-party names. Preserve token text
for fallback/copy and fall back from animated art to static art to text. Cheermote catalogs are
room data; their custom URLs use the webview cache and do not enter ordinary completion or the
provider-ID image cache.

[message_effects.rs](../../src-tauri/src/twitch/message_effects.rs) adds typed Cosmic Abyss,
Rainbow Eclipse, or Emote Party metadata beside unchanged body text. Unknown markers stay plain.
Decoration never enters completion, copied text, replies, or accessibility text. Deleted rows
lose effects. `MessageEffectFrame` observes render-time display/animation switches; static and
reduced-motion modes avoid animated assets and CSS movement. A shared visibility observer and
document visibility pause hidden animation and disconnect when no frames remain.

## Provider catalogs and badges

Providers load globals and room sets concurrently. `emote-catalogs.json` stores separate provider
snapshots and the 128 most recently refreshed rooms. Install cached catalogs before/at join,
then refresh; successful empty sets differ from failures. A per-room async lock coalesces asset
loads across accounts. Revision checks prevent an older HTTP response from overwriting a newer
7TV socket change.

One anonymous 7TV event socket reconciles currently wanted set IDs. Added/removed/renamed emotes
update shared room data, account-stamped notices, and completion events. Keep the FFZ/BTTV
`other_emotes` map so removing a shadowing 7TV name restores the underlying emote; guard removals
by ID. Disabling providers removes backend catalogs and reloads joined rooms; frontend rendering
also honors the switch so retained rows immediately show text.

7TV badge lookup accepts numeric Twitch user IDs and batches up to forty GraphQL aliases after
a 400 ms collection period. Both positive and negative results are cached. The disk cache holds
20,000 recently refreshed users with 24-hour freshness; stale positive art appears while refreshing.
Badge results arrive independently of messages, so rows subscribe to their sender's badge entry.
Re-enabling badges clears the already-asked set to permit cache/provider resolution again.
GraphQL errors, missing data, or missing requested aliases are failures even with HTTP 200;
never persist them as negative badge answers or erase a last-known badge.

`badge-catalogs.json` also keeps Twitch global/channel definitions, bounded to 128 rooms.
Twitch definitions are installed only with credentials; sign-out clears visible maps and leaves
text badge chips. Public account-independent metadata does not require the viewing tab's account.

## Image cache

`emote://` serves a lazy 300 MB disk recency cache. Keys use provider IDs, not channel aliases;
badge keys fingerprint their URL. Concurrent misses share a download and failure falls back to
the CDN. Badge URLs must be recognized metadata on approved Twitch/7TV HTTPS image hosts;
webview keys must never become arbitrary backend fetch URLs.
Enforce the 4 MB per-image download cap while reading chunks, as well as against declared length,
so an oversized or unterminated response is rejected before buffering the full body.

Evict oldest inactive images first, then active ones if needed to enforce the hard bound.
Until every joined channel has loaded, use ordinary recency rather than favoring a partial
working set. Serving touches modification time, and maintenance removes interrupted temporary
downloads. FFZ deliberately bypasses this cache: an ID alone cannot choose static versus animated
paths. Keep Rust's valid provider keys and `EmoteImage`'s cached-provider set consistent.

## Completion

Per-tab completion combines enabled third-party maps with Twitch global/account and channel/session
catalogs. Anonymous tabs have third-party entries only. Twitch catalogs are not ownership lists;
they can suggest subscriber emotes the account cannot send and stay separate from rendering maps.
Account or asset changes rebuild completion indexes.

Tab completion is prefix-only. The colon picker ranks prefixes before substrings, with emoji
below emotes. Both rank emotes by shared persisted send counts and then alphabetically. Generated
[emoji.json](../../src/lib/emoji.json) loads lazily; selection inserts literal Unicode characters.
[chatterComplete.ts](../../src/lib/chatterComplete.ts) uses names seen this session, excludes the
viewing account, searches login/display name, and inserts display casing. Listener selection stores
the canonical login. See [development](../development.md) for emoji regeneration.
