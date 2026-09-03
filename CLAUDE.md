# CLAUDE.md

Guidance for Claude Code when working in this repo. Keep this file short — put anything
derivable from the code itself in the code, not here.

**Two other docs, and they don't overlap.** [ARCHITECTURE.md](ARCHITECTURE.md) is the long
form of everything below: how the pieces fit, and the reasoning behind the decisions this file
only states. Read it before changing anything structural, and keep it current when you do.
[README.md](README.md) is for the person *using* the app — no file paths, no internals, no
reasoning; nothing there is written for an agent.

## What this is

A Tauri 2 + React 19 desktop Twitch chat client. Rust owns the IRC connection, 7TV/Helix
fetching, and message resolution; React only renders pre-resolved data. Don't move parsing or
resolution logic into the frontend — see
[ARCHITECTURE.md](ARCHITECTURE.md#the-rustreact-boundary) for why that boundary is where it is
before changing it.

## Commands

```bash
npm run tauri dev          # full app, rebuilds Rust on change (slow iteration loop)
npm run dev                 # Vite only, no Rust backend — runs in mock mode (see below)
npm run build                # tsc + vite build (type-check the frontend)
cd src-tauri && cargo test          # Rust unit tests
cd src-tauri && cargo test -- --ignored --nocapture   # + livecheck.rs, hits real Twitch/7TV APIs
TWITCH_CLIENT_ID=xxx npm run tauri build    # build against a different Twitch app
npm run build:local         # a release build on your own machine (see below)
CHATWOW_LOG=debug npm run tauri dev  # turn the log up for one run (see diagnostics.rs)
python3 scripts/generate-emoji.py   # regenerate src/lib/emoji.json (don't hand-edit it)
npx tauri icon app-icon.png         # regenerate src-tauri/icons (see the note below)
python3 scripts/bump-version.py 0.6.0   # set the version in all five files at once
git tag v0.3.0 && git push origin v0.3.0    # build installers (see .github/workflows/release.yml)
CHATWOW_UPDATE_ENDPOINT=https://.../latest.json npm run tauri dev  # rehearse an update
```

`npm run tauri build` fails on a developer machine with "A public key has been found, but no
private key": `createUpdaterArtifacts` is on, so every build wants to sign, and the minisign key
lives only in the repo secrets. `npm run build:local` merges
[src-tauri/tauri.local.conf.json](src-tauri/tauri.local.conf.json) over the real config to turn
those artifacts off, which is right for a local build -- nobody installs one, and a bundle
signed with a key CI doesn't have is worse than one that isn't signed at all. Don't set
`TAURI_SIGNING_PRIVATE_KEY` by hand to get around it; that puts the key and its password in your
shell history for no gain.

`app-icon.png` at the repo root is the source the icons are cut from, and the only one to edit.
`tauri icon` also writes `src-tauri/icons/android/` and `ios/`, which this desktop-only app has
no use for -- delete both after running it.

The version lives in five files that have to agree: `package.json`, `package-lock.json` (in two
places), `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.lock`. Use the
bump script rather than doing it by hand -- a mismatch isn't cosmetic any more, since the tag
comes from `tauri.conf.json` while the version the updater compares against is Cargo's. The tag
push is what builds the Windows, macOS and Linux installers -- on their own runners, since Tauri
doesn't test cross-compiling NSIS -- and they land on a *draft* release, published by hand.
Publishing that draft is what ships the update to everyone: see the updater bullets below.

Launch the desktop app only through `npm run tauri dev`. Running the built debug binary
directly (`src-tauri/target/debug/chatwow`) opens a window that never loads the frontend --
a blank white page with no JS running at all, which looks exactly like an app bug.

Run `cargo test` after any change under `src-tauri/src/`, and `npm run build` after any
frontend change — both are fast and catch most regressions before manual testing.

## Design iteration without a Rust rebuild

`npm run dev` (no `tauri`) opens the same React app in a bare browser tab. `IS_TAURI`
([src/lib/tauri.ts](src/lib/tauri.ts)) detects this and the store
([src/store/chat.ts](src/store/chat.ts)) branches: outside Tauri it seeds data from
[src/dev/mockData.ts](src/dev/mockData.ts) (real CDN emote/badge URLs) and runs a synthetic
message stream instead of calling `invoke`. Use this loop for pure UI/CSS work; use
`npm run tauri dev` when touching anything that talks to the backend. The mock module is
dynamically imported so it never ships in a production bundle — if you add mock data, keep it
behind that same dynamic `import()`.

Mock mode signs in three accounts -- `you` and `you_alt` with tabs, `you_spare` idle and without
a picture -- and opens four tabs, including the same channel under both of the first two, which is
the case the multi-account work exists for. That gives the reply-to-you and mention highlights an
identity to match against (some mock drafts tag `@you` and use the bare name deliberately) *and*
a second identity they must not match, so a mention landing in the wrong tab is visible without
signing in to Twitch. The accounts hold different scopes, so the command picker's locked rows are
exercisable too. Preferences fall back to `localStorage` there, since there's no backend to write
`settings.json`.

The update flow has its own fake ([src/dev/mockUpdates.ts](src/dev/mockUpdates.ts)), behind the
same dynamic import: pressing the button walks idle -> available -> downloading -> ready, and
`?update=fail` or `?update=uptodate` reaches the two stages that walk can't.

## Non-obvious constraints (read before touching related code)

- **Twitch's `emotes` IRC tag indexes by Unicode code point, not bytes or UTF-16 units.**
  Any message containing an emoji or other non-BMP character will have corrupted emote
  ranges if you slice on `&str`/bytes. Always collect to `Vec<char>` first
  ([src-tauri/src/render.rs](src-tauri/src/render.rs)). There's a test named
  `emote_ranges_are_indexed_by_codepoint_not_bytes` guarding this — don't delete it.
- **`badges.twitch.tv` is dead (DNS doesn't resolve).** Badge *images* require the
  authenticated Helix API (`GET /helix/chat/badges/...`); chat, emotes, and name colors all
  work fully anonymously. Without sign-in, badges degrade to text chips — that's intentional,
  not a bug to "fix" by finding another badge endpoint.
- **7TV zero-width emotes must be folded onto the preceding emote's `overlays`, not rendered
  as their own segment.** The flag is `data.flags & 256` from the 7TV v3 API. Getting this
  wrong makes emote combos (e.g. `ppL RainTime PETPET`) render side-by-side instead of
  stacked.
- **Twitch's emote names are fetched for completion only, never for rendering.**
  [src-tauri/src/twitch/emotes.rs](src-tauri/src/twitch/emotes.rs) populates the completion
  index; an incoming message's own `emotes` tag is what resolves Twitch emotes for rendering.
  Don't merge those names into `ChannelData::emotes` or `global_emotes` to save a lookup — those
  maps are matched by name against message *text*, so any word matching an emote name would
  render as that emote even from someone who doesn't own it.
- **A channel's 7TV set can change while you're reading it, and one socket watches every open
  one.** [src-tauri/src/emotes/seventv_events.rs](src-tauri/src/emotes/seventv_events.rs)
  subscribes to `emote_set.update` on 7TV's EventAPI, keyed by the set id
  `seventv::fetch_channel` now returns alongside the emotes. Unlike Twitch's EventSub these
  events are anonymous and belong to the *room*, so there's one socket for the app rather than
  one per account; `AppState::seventv_events` is the `Notify` that every join, part and provider
  switch pokes, and with nothing left to watch the socket is let go rather than held idle. A
  *removal* is why `ChannelData::other_emotes` exists: `emotes` is the three providers merged
  with 7TV on top, so dropping a name would take a shadowed FFZ or BTTV emote with it -- keep
  the lower half separately, and guard every removal on the emote's id. The line it writes is an
  ordinary notice stamped once per account with a tab on that channel; `announce_emote_changes`
  gates the line only, never the emotes.
- **7TV badges are resolved per chatter, and there's no bulk endpoint any more.** The v3
  `/v3/cosmetics` route that served every badge and its owners now 404s; v4 answers one user at a
  time through GraphQL, so [src-tauri/src/emotes/seventv_badges.rs](src-tauri/src/emotes/seventv_badges.rs)
  aliases forty `userByConnection` lookups into one query and maps them back by position. Ids are
  interpolated into that document as string literals, so `is_user_id` rejects anything non-numeric
  -- don't relax it. `AppState::queue_badge_lookup` remembers everyone asked about, badge or not,
  so nobody is looked up twice. The answers ride to the frontend as `chat://seventv-badges` and
  live in the store, never on the message: they arrive *after* the message that prompted the
  lookup, and a stored message is immutable, so a row that already rendered would never get one.
- **Follow age and cumulative sub months aren't in the Twitch API for anyone but you.** `Get Users
  Follows` was removed in 2023 and both replacements are scoped to the caller: `/channels/followed`
  needs your own id in the token, `/channels/followers?user_id=` needs `moderator:read:followers`
  and for you to be broadcaster or mod there. The user card gets that half from api.ivr.fi
  ([src-tauri/src/usercard.rs](src-tauri/src/usercard.rs)), one person's service with no SLA -- so
  it lands in its own nullable `history` field rather than beside the avatar and account age.
  `None` there means "didn't answer", *not* "doesn't follow, never subscribed", and the card draws
  those rows as unavailable; only when both halves fail is there an error instead of a card. Don't
  flatten it into the rest of the payload, and don't reach for `badge-info` as a substitute -- that
  carries months only for a current subscriber who has already spoken in that channel. Logins go
  into a URL path, so `is_login` rejects anything outside `[A-Za-z0-9_]{1,25}`.
- **Link previews are the one fetch that goes wherever a chatter pointed.** Everything else here
  talks to Twitch, 7TV, BTTV, FFZ or ivr.fi -- hosts compiled in. `linkinfo::build_client`
  ([src-tauri/src/linkinfo.rs](src-tauri/src/linkinfo.rs)) is therefore its own client, kept in
  `AppState::link_http`: a redirect policy that refuses each hop that isn't `http(s)` on a public
  host, an eight-second timeout, and a body read in chunks and stopped as soon as it holds what's
  wanted (`</head>`, capped at 256KB). Don't route a link fetch through `state.http`, and don't
  drop the host check because "the user could have clicked it anyway" -- this happens on *hover*,
  without a click. The two `preview*` preferences are enforced in the frontend only (Rust
  fetches whatever `link_preview` is handed), so a switch has to stop the call; which one applies
  is decided by `linkKind` ([src/lib/links.ts](src/lib/links.ts)) from the url alone, before
  anything is asked. The split is what's promised, not which resolver answers: `previewImages` is
  the two that show a picture -- an image url, and a 7TV emote link -- and `previewPages`
  everything else, Twitch's Helix path and YouTube's megabyte included. A link that points
  straight at an image is never fetched by Rust at all: the frontend renders an `<img>`.
- **A 7TV emote link is answered by the 7TV API, and drawn as an emote.** `seventv_links`
  ([src-tauri/src/emotes/seventv_links.rs](src-tauri/src/emotes/seventv_links.rs)) recognizes
  `7tv.app/emotes/<id>`, asks `GET /v3/emotes/<id>`, and returns a `LinkPreview` whose
  `description` is the *owner* -- the frontend renders it through the emote card (image, name,
  who by), not the page card, whose `object-cover` thumbnail would crop a 128px emote into a
  face. `linkKind` mirrors the same url shape so the switch can be read before the call. Public
  endpoint, so unlike the Twitch path it works signed out; a miss or a failure still falls
  through to the page scrape.
- **A Twitch link is answered by Helix, not by reading twitch.tv.** The page is a React shell
  whose og: tags say nothing, so `twitch::links` ([src-tauri/src/twitch/links.rs](src-tauri/src/twitch/links.rs))
  matches clip/VOD/channel urls and asks Helix instead, from the command in
  [src-tauri/src/lib.rs](src-tauri/src/lib.rs) before `linkinfo` is reached. Every part of it is
  best-effort by design -- signed out there's no token (and no client secret to mint an app token
  with), so a miss, a failure or an absent token falls through to the page scrape. Don't make that
  path return an error: the fallback is what keeps previews working signed out. A live channel's
  preview sets `ttl_seconds`, which is the only reason the frontend cache re-asks for anything --
  viewer counts and uptimes go stale, clips and page titles don't.
- **A YouTube video url is read to a megabyte, on purpose, and `reqwest` needs its compression
  features for that to be sane.** YouTube puts the head behind ~700KB of inline script and the
  view/like counts behind more, so `youtube_id` recognizes a video url up front and gives that
  fetch its own budget, stopping once the last field has turned up. That page is ~5x smaller on
  the wire, which is the whole justification -- if `gzip`/`brotli` come off `reqwest` in
  Cargo.toml, this quietly becomes a megabyte of real traffic per hover. Pretending to be a known
  crawler would get the same metadata in 2KB (YouTube reorders the page for `facebookexternalhit`
  and friends); the user agent stays honest instead, and the cost is paid in bytes.
- **Emote providers are merged by name, lowest priority first.** `emotes::merge`
  ([src-tauri/src/emotes/mod.rs](src-tauri/src/emotes/mod.rs)) folds FFZ, then BTTV, then 7TV into
  one name→`Emote` map, so 7TV wins a shared name -- it's the set channels actually curate. Change
  that order and emotes silently swap provider in every channel that has both. Channel sets are
  fetched and merged the same way, and overwrite the globals by landing in `ChannelData::emotes`.
- **Switching a provider off has to be handled twice, and both halves are load-bearing.** Rust
  skips fetching it (`Providers` in [src-tauri/src/emotes/mod.rs](src-tauri/src/emotes/mod.rs)), so
  the service is never asked and its emotes leave completion -- but the messages already rendered
  were resolved before the switch and are immutable, so `EmoteView` also asks
  [src/lib/emoteProviders.ts](src/lib/emoteProviders.ts) on every render and draws the plain word
  instead. `set_preferences` respawns `client::reload_emotes` when the set changes, which is what
  makes switching one back *on* fetch anything.
- **FFZ images can't be served from the `emote://` cache.** FFZ puts animated emotes on a
  different path (`/emote/<id>/animated/2.webp`) from static ones, and a cache key is only
  `<provider>-<id>` -- nothing in it says which kind. Asking for the animated url of a static
  emote doesn't 404, it hangs, so probing isn't an option either. `is_valid_key`
  ([src-tauri/src/emotes/cache.rs](src-tauri/src/emotes/cache.rs)) deliberately omits `ffz`, and
  `CACHED_PROVIDERS` in [src/components/EmoteImage.tsx](src/components/EmoteImage.tsx) mirrors it;
  FFZ emotes use the CDN url the API gave us, which is already the right one for either kind.
- **Emote images are cached on disk by provider id, never by name.** 7TV names are aliased
  per channel, so the same image arrives under different names and one name can mean different
  images in different channels. [src-tauri/src/emotes/cache.rs](src-tauri/src/emotes/cache.rs)
  keys `<provider>-<id>` and serves it over an `emote://` scheme registered in
  [src-tauri/src/lib.rs](src-tauri/src/lib.rs); the frontend falls back to the CDN url when
  that 404s. Purging stale entries has to wait until *every* joined channel's set has loaded --
  purging on a partial picture evicts images the other channels are about to ask for.
- **Twitch chat commands don't work over IRC any more.** Sending `/ban someone` as a PRIVMSG
  posts those eleven characters as a message -- Twitch retired the IRC command handler in 2023.
  Every command is a Helix call with its own scope
  ([src-tauri/src/twitch/commands.rs](src-tauri/src/twitch/commands.rs)). Don't "simplify" any of
  this back into the send path. `/me` genuinely is a message (a CTCP ACTION) and stays there.
- **The backlog on join comes from a third party, as raw IRC lines.** Twitch has no chat history
  for third-party clients, so [src-tauri/src/irc/history.rs](src-tauri/src/irc/history.rs) asks
  recent-messages.robotty.de, which answers with IRC lines tagged `historical=1` -- they go
  through the same parser and renderer as the live socket, which is the whole reason this is
  ~60 lines. Three things there are load-bearing: the fetch runs *before* `ready` is set (so live
  messages keep buffering and the backlog lands above them, not below); the reply is filtered to
  PRIVMSG and USERNOTICE (a historical ROOMSTATE fed back through `handle_line` would re-trigger
  the asset load that asked for the history); and the overlap with `pending` is dropped by
  message id, since the history runs up to now and the buffer starts partway through it. The
  `historical` flag rides all the way to the frontend, where it keeps a backlog from pinging or
  counting as unread.
- **A dropped socket is announced in chat, and the gap is filled from the history service.**
  `announce_drop` ([src-tauri/src/irc/client.rs](src-tauri/src/irc/client.rs)) writes a notice
  into every channel the account was reading and stamps each session with `interrupted_at`;
  `resume_channel` runs on the ROOMSTATE that comes with the rejoin, and is checked *before*
  `needs_fetch` -- a dropped session is also not ready, and running the whole join would re-ask
  Twitch for emotes it has and replay a backlog already on screen. Where the gap starts is
  `Session::last_seen` frozen *at the drop*: live messages arrive the moment we're back and would
  otherwise push the mark past the gap. `last_seen` is an `AtomicI64` so it can be written under
  the read guard the readiness check already takes, and `load_channel_assets` seeds it from the
  join backlog -- without that a channel quiet since the join has no mark and recovers everything.
  Recovered messages stay `historical`, so they don't ping or count as unread.
- **Whispers don't come over IRC.** Twitch delivers them through EventSub only, so
  [src-tauri/src/twitch/eventsub.rs](src-tauri/src/twitch/eventsub.rs) runs a second WebSocket
  subscribed to `user.whisper.message`. Don't go looking for a `WHISPER` IRC command to handle --
  there isn't one any more. The event carries the sender and the text and nothing else, so a
  whisper has no badges, no color and no emote ranges; `render::whisper` resolves what the text
  alone can give and leaves the rest empty. It has no channel either: Rust sends `channel: ""`
  and the store files it under whichever channel you're reading, since only the frontend knows
  which that is.
- **Whether you can moderate a channel is only knowable from your own `USERSTATE`.** There's no
  Helix endpoint for "am I a mod in someone else's channel", so `ChannelRole`
  ([src-tauri/src/irc/parse.rs](src-tauri/src/irc/parse.rs)) reads the `mod` tag and the badges
  off the USERSTATE Twitch sends on join, and `chat://role` carries it to the command picker.
  The broadcaster's own USERSTATE says `mod=0` -- the `broadcaster/1` badge is the only signal,
  which is why the role isn't just that tag. Twitch repeats USERSTATE after every message you
  send, so only a real change is emitted.
- **`/mods` and `/vips` can't work outside your own channel, however they behave in Twitch's own
  chat.** Helix's Get Moderators and Get VIPs both require `broadcaster_id` to match the user in
  the token, and no public endpoint lists anyone else's. Twitch's web client uses an internal
  API. The gate in `twitch::commands::require_broadcaster` is that limit, not caution -- don't
  "fix" it by dropping the check, which just moves the failure to a cryptic Twitch error.
- **Scopes are granted once, at sign-in, and can't be escalated afterwards.** Ticking a
  permission group only changes what the *next* sign-in asks for, so
  `AuthStatus.permission_groups` (what we'll ask for) and `AuthStatus.scopes` (what the token
  carries, from `/oauth2/validate`) are deliberately separate, and only the latter decides
  whether a command can run. A UI that reads the ticked boxes as capability will claim commands
  work that Twitch will refuse.
- **Client ID precedence: an explicit override beats compiled-in, and there is always a
  compiled-in one.** [src-tauri/build.rs](src-tauri/build.rs) emits `TWITCH_CLIENT_ID` from a
  committed default whenever the env var is unset, so `option_env!` in
  [src-tauri/src/auth.rs](src-tauri/src/auth.rs) is never `None` and no build can ship asking
  users to register a Twitch app. `Auth::client_id()`
  ([src-tauri/src/state.rs](src-tauri/src/state.rs)) then lets `client_id_override` win, which
  is the only way off a suspended or rate-limited Twitch app without shipping a release. The
  two rules coexist because the override has its *own settings key*: the old `client_id` field
  is not read, so a file left by an earlier build still can't redirect a shipped build — only a
  deliberate action in this one can. If you add a new place that reads the client ID, go through
  `Auth::client_id()`, never `client_id_override` or `BUILT_IN_CLIENT_ID` directly. `build.rs`
  must keep `cargo:rerun-if-env-changed=TWITCH_CLIENT_ID` or changing the env var won't trigger
  a rebuild.
- **Changing the Client ID has to clear the session.** Twitch issues a token against one
  specific Client ID, so a token held across a switch is dead weight that reads as a broken
  session rather than a signed-out one. `set_client_id_override` and `logout` share
  `clear_session` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) for exactly this.
- **Nothing is written down unless it goes through `log`, and a spawned task's panic is silent
  without `diagnostics::supervise`.** [src-tauri/src/diagnostics.rs](src-tauri/src/diagnostics.rs)
  installs `tauri-plugin-log` (one rotating file in the OS log dir), a panic hook that chains the
  default one and forces a backtrace, and `supervise`, which is what long-lived tasks are spawned
  through -- `tauri::async_runtime::spawn` hands back a `JoinHandle` nothing awaits, so a panic
  inside one kills that socket in total silence. Use `log::warn!`/`error!`, never `eprintln!`: in
  a bundled build stderr goes nowhere. The hook must be installed *after* the plugin, or the
  first panic has no logger to write to. Two things must never reach the file, since the user is
  invited to attach it to a bug report: an access token, and the text of anybody's messages.
- **Tauri's `setup()` hook runs outside any Tokio runtime context.** Calling `tokio::spawn`
  there panics with "there is no reactor running." Use `tauri::async_runtime::spawn` for
  anything spawned during setup (see [src-tauri/src/irc/client.rs](src-tauri/src/irc/client.rs)).
- **Don't hold a `parking_lot` `RwLock` read guard across an `.await`.** It's not `Send`, so
  the containing future won't compile under `tauri::async_runtime::spawn`. Clone what you need
  into an owned value before the await point.
- **Colors are lifted for contrast, not just clamped for lightness.** A fixed HSL-lightness
  floor isn't enough — pure blue (`#0000FF`) and pure yellow at the same lightness have very
  different contrast against the dark background. [src-tauri/src/color.rs](src-tauri/src/color.rs)
  iterates lightness until the actual WCAG contrast ratio against the background hits 4.5:1.
  If a name color still looks unreadable, check the contrast math, don't just raise a lightness
  constant.
- **Tauri installs a default menu on macOS, and it owns `Cmd+W`.** A menu key equivalent is
  matched before the keystroke reaches the webview, so the frontend's close-tab shortcut can
  never fire while a Close Window item exists -- the window vanishes instead. `macos_menu`
  ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) is the default menu with that one item dropped,
  and it's `#[cfg(target_os = "macos")]` on both sides: no other platform gets a menu from Tauri,
  and setting one on Windows would draw a menu bar into a window that has `decorations: false`.
  Don't swap it back for `Menu::default` or `enable_macos_default_menu` -- the first breaks
  `Cmd+W`, the second takes `Cmd+Q` and the Edit items (copy and paste in the composer) with it.
- **macOS keeps its native window frame; every other platform doesn't.** Square corners and no
  system shadow are what `decorations: false` gets you, and on macOS that reads as a foreign
  window. [src-tauri/tauri.macos.conf.json](src-tauri/tauri.macos.conf.json) turns decorations
  back on with `titleBarStyle: "Overlay"`, so the system draws the traffic lights over our own
  title bar and we draw no window buttons of our own -- `IS_MACOS`
  ([src/lib/tauri.ts](src/lib/tauri.ts)) gates both that and the left padding the lights sit in.
  The bar is 36px there rather than 32, because the traffic lights are a fixed system size and
  the only way to stop them dominating is to give them more room -- nothing Tauri exposes can
  scale them. That is what `trafficLightPosition` is paying for: 28px is the standard title bar
  height, and at exactly 28 the system centres the lights for free, so any other height has to
  place them by hand. `y` is not an offset from the top -- tao resizes the title bar container to
  `buttonHeight + y` and lets the buttons keep their own offset inside it, so a larger `y` moves
  them down and the value that centres them is calibration rather than arithmetic.
  Tauri *replaces* rather than merges the
  `app.windows` array when it picks up a platform config, so that file repeats the whole window
  object: change a size, a title or a background colour in `tauri.conf.json` and it has to change
  in both. `hiddenTitle` is what stops macOS drawing the window title across our own.

  The config is compiled in, and `build.rs` only asks Cargo to watch the files it found *last*
  time it ran. So creating a platform config for the first time changes nothing until something
  else forces a rebuild -- `tauri dev` will keep running the old window. `touch
  src-tauri/tauri.conf.json` and build again; from then on both files are watched and an edit to
  either is picked up on its own.
- **`dragDropEnabled` must stay `false`** ([src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)).
  Tauri's default native drag-drop handling intercepts drag events at the window level for OS
  file-drop support, which swallows the HTML5 Drag and Drop API before the page ever sees it —
  on Windows this shows the "not allowed" cursor the instant you try to drag anything (e.g. the
  tab-bar reorder in `TabBar.tsx`). This app has no file-drop feature, so there's nothing to
  trade off by leaving it disabled.
- **Pinning chat to the bottom can't trust `scrollHeight` alone.** `.msg-row` is
  `content-visibility: auto` with a one-line `contain-intrinsic-size`
  ([src/styles.css](src/styles.css)), so a row still below the fold measures a single line however
  many it wraps to. `scrollTop = scrollHeight` straight after a batch lands therefore stops short
  by the lines the estimate missed, leaving the newest message clipped -- and short by less than
  `PIN_THRESHOLD`, so the scroller still counts as pinned and never offers a way down.
  [src/components/ChatView.tsx](src/components/ChatView.tsx) observes the rows' wrapper with a
  `ResizeObserver` and re-pins once the real height lands; keep that if you touch the scroller or
  the row CSS.
- **A mentions tab is an ordinary tab with no channel, and there's one per account.** `kind:
  "mentions"` with an empty `channel`, so it drags, closes and counts unread through exactly the
  same code as a channel tab -- nothing in the tab bar or the panes knows it's different. It
  renders `mentionLog[account]`, which `ingest` fills with the *same message objects* the channel
  tabs get, so anything that rewrites a stored message (`clear`) has to rewrite both copies or
  the two views disagree. Per account because a mention is addressed to a login: what names one
  of yours names only that one. One exemption in the UI: the rose bar at a scrolled-off tab-bar
  edge skips it, since pointing at the tab those are already gathered in says nothing new.
- **Ignoring and blocking are matched in the frontend, like the emote blacklists and for the same
  reason** ([src/lib/ignores.ts](src/lib/ignores.ts)). Rust only persists the two lists. An
  ignored mention keeps its message but loses everything a *mention* has -- ping, count,
  highlight, and its place in the mentions tab -- while a blocked user's message isn't drawn at
  all (`MessageRow` returns null). Blocking implies ignoring: a row that isn't drawn must not
  still be ringing a bell. Both are local; Twitch's own block needs a scope this app doesn't ask
  for and still delivers the messages over IRC, so it would need this half regardless.
- **A tab, not a channel, is the unit everything is keyed by.** Several accounts can be signed
  in and each tab picks one, so the same channel can be open twice and a channel name no longer
  identifies a view. `settings::Tab` (`id`, `kind`, `channel`, `account`) does: messages, unread,
  scroll, sent history, completable emotes and role are all keyed by tab id, while emote sets,
  badges, room id, live state and the owner's avatar stay keyed by channel because they belong to
  the *room*. Ids are minted in the frontend so a new view has a key before the round trip.
- **One IRC socket per account, and `client::sync` is the only thing that opens or closes one.**
  IRC authenticates per connection -- the login *is* the connection -- so reading as two accounts
  is two sockets, and whispers need one EventSub socket per account on top. Every tab change ends
  at `sync` ([src-tauri/src/irc/client.rs](src-tauri/src/irc/client.rs)), which diffs
  `AppState::wanted` against the live connections; don't join or part from anywhere else. Each
  rendered message is stamped with the account whose socket received it (`ChatMessage::account`),
  and that stamp is what routes it to a tab -- with a channel open twice the two copies are
  otherwise identical.
- **A channel's assets load once; a session's load per account.** `ChannelData` holds what
  belongs to the room (emotes, badges, room id); `state::Session`, keyed by (account, channel),
  holds what belongs to one login in it: `ready`, the pre-ready buffer, the `USERSTATE` role, and
  that account's own Twitch emotes. A second account joining a room the first is already in still
  needs its own backlog and its own `ready` -- don't collapse the two back together.
- **Renewing a token must not restart the sockets.** Re-validating a good token rewrites its
  scopes and login, which is worth persisting but is *not* a credentials change -- reconnecting
  the whisper socket every launch orphans its EventSub subscription, and three of those is
  Twitch's limit for one type and condition, after which whispers silently stop. That's why
  `changed` and `credentials_changed` are separate in
  [src-tauri/src/lib.rs](src-tauri/src/lib.rs); this was a real bug. The same holds for a
  *refreshed* token, which `poll_tokens` stores without telling anyone: IRC authenticates once at
  connect and `connect_once` picks the new one up at its next reconnect. Only an account that has
  been lost reconnects anything, because its tabs have just gone anonymous.
- **Tokens expire mid-session, and only `check_token` renews one.** A Twitch user token lasts
  hours and the app runs for days, so `poll_tokens` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs))
  re-checks every account hourly and renews anything inside `REFRESH_MARGIN_SECS` -- which has to
  stay wider than `TOKEN_CHECK_SECS`, or a token can die between two checks. `restore_session`
  makes the same pass at launch through the same function, and its first tick is deliberately
  swallowed so the two can't race: a second refresh presenting a spent refresh token gets a
  refusal, which is indistinguishable from a dead grant. Don't add a second place that refreshes.
  Failing to renew is not the same as being refused -- `auth::RefreshOutcome` keeps `Rejected`
  (grant gone, drop the account) apart from `Unreachable` (know nothing, change nothing), and
  merging them signs everyone out whenever the network is slower to wake than the app.
- **Anonymous is an account, not a failure.** `settings::ANONYMOUS` (the empty id) is how the app
  works signed out, stays a per-tab choice afterwards, and is where a tab lands when its account
  is signed out -- it keeps reading and loses its composer. Calls that ask Twitch about the world
  (badge art, who's live, search, link previews) go through `Auth::any_credentials`, not the
  tab's account, or a signed-in app would lose them the moment a tab went anonymous.
- **Scopes are per account; what to *ask* for is shared.** `permission_groups` is one list for
  the whole app (what the next sign-in requests), `Account::scopes` is what that token actually
  got. `commandProblem`/`problemLabel`/`helpLines` ([src/lib/commands.ts](src/lib/commands.ts))
  therefore all take an account, and two tabs on one channel can honestly offer different
  commands.
- **Which pane a tab is in is a boundary in `tabs`, not a second list.** `splitIndex`
  ([src-tauri/src/settings.rs](src-tauri/src/settings.rs)) counts the leading tabs belonging to
  the first pane, so `tabs` stays the one record of what's open and in what order and a
  cross-pane drag is a move within it -- nothing can land in both panes or neither. Derive with
  `paneTabs`/`paneOf` and write back through `commitTabs`
  ([src/store/chat.ts](src/store/chat.ts)); don't add a per-pane list that then has to be
  reconciled against `tabs` on every open, close and reorder.
  `active` is a pair, one tab per pane, and *both* count as "what you're reading" for unread and
  pings; `focusedPane` is the narrower question of where a whisper lands, what Ctrl+W closes, and
  which half a new tab drops into.
- **Only one composer may listen for typing.** `Composer` reclaims focus on any keystroke in the
  window so chat feels always-focused, so in a split window two of them would take turns stealing
  the caret. `capturesTyping` ([src/components/Composer.tsx](src/components/Composer.tsx)) is
  that switch -- the focused pane, or the other one when the focused pane has nothing open -- and
  it gates the mount-time focus too: a composer mounting in the pane you *aren't* working in
  would otherwise pull the caret across and, through `Pane`'s focus handler, the pane focus with
  it. That was a real bug: dragging a tab into the other pane focused it, then bounced straight
  back.
- **A menu belonging to a fixed control must not close on scroll.** `ContextMenu` closes on any
  scroll by default, which is right for a menu opened on a message -- but chat scrolls itself
  every time a message lands, so the title bar's split menu was shut before it could be read.
  Hence `closeOnScroll` ([src/components/ContextMenu.tsx](src/components/ContextMenu.tsx)); pass
  it `false` for anything anchored to a control rather than to content.
- **The minisign private key is the one unrecoverable thing in this project.** It lives in the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret and nowhere in the tree. Every installed copy only
  accepts a download signed with it, and there is no way to hand them a different key -- losing
  it orphans every install permanently, and the only remedy is telling everyone to reinstall by
  hand. It is not Apple's or Microsoft's code signing, which this app still doesn't have; the
  updater verifies with minisign alone and never consults Gatekeeper.
- **`bundle.targets` must keep `app` and `appimage`, and must not regain `msi`.** The macOS
  updater artifact is built from the `.app` rather than the `.dmg`, and AppImage is the only
  Linux format the bundler makes one for -- drop either and that platform's updates vanish with
  no error anywhere. `msi` is out because Tauri's NSIS template force-uninstalls a WiX install
  with no choice offered, which is what made Windows upgrades ask users to uninstall first.
  `deb` and `rpm` stay, and they self-update fine -- the bundler stamps each binary with its own
  format, so every Linux install asks `latest.json` for its own key and the plugin runs `dpkg -i`
  behind a root prompt rather than swapping a file.
- **macOS can't self-update until the app is signed, and that's the one line to change when it
  is.** `updater::can_install` returns false there because replacing an *unsigned* bundle in
  place is what makes macOS call the app damaged and refuse to open it -- a worse outcome than
  no update. Ad-hoc signing doesn't clear it. Remove the `#[cfg(target_os = "macos")]` arm only
  once a Developer ID Application certificate and notarization are actually in the release
  workflow (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID` and friends), not before.
  It's the only thing `can_install` gates. Where it's false the check still runs and the button
  opens the releases page.
- **Don't re-parallelize the release matrix.** `tauri-action` builds `latest.json` by downloading
  the copy on the release, merging its own platform in and re-uploading it, so two jobs finishing
  together lose one platform's entry -- silently, and only that platform then stops seeing
  updates. `max-parallel: 1` in [.github/workflows/release.yml](.github/workflows/release.yml) is
  load-bearing. Check the file before publishing a draft; a missing key means the race bit, and
  no `latest.json` at all means the signing secret never reached the runner.
- **The update check is the only thing this app asks github.com**, and it's the only host here
  besides Twitch, 7TV, BTTV, FFZ, ivr.fi and robotty -- which is why it has a preference of its
  own (`check_for_updates`) rather than being unconditional. It never downloads; that waits to be
  asked. Everything about it lives in Rust ([src-tauri/src/updater.rs](src-tauri/src/updater.rs)),
  deliberately: granting `updater:default` would let the webview download and execute code in an
  app that renders arbitrary chat under `csp: null`, and nothing about an update depends on which
  login is reading. `capabilities/default.json` should stay untouched.
- **The window-state plugin runs on three flags, not its default `all()`.** `DECORATIONS` would
  let a saved value argue with `decorations: false` in
  [tauri.conf.json](src-tauri/tauri.conf.json), which is what gives this app its own title bar,
  and `VISIBLE` can restore a window that was hidden -- an app that starts invisible and is only
  fixable by deleting a file the user has never heard of. `SIZE | POSITION | MAXIMIZED` is the
  whole feature. No capability is needed and none is granted: save and restore run from the
  plugin's Rust hooks (`on_window_ready`, `on_window_event`, `RunEvent::Exit`), and permissions
  only gate `invoke()` from the webview. It writes its own `.window-state.json` beside
  `settings.json` rather than living in it, which is why nothing in `settings::Settings` mentions
  the window.
- **A tab's rendered width must never change on hover** ([src/components/TabBar.tsx](src/components/TabBar.tsx)).
  The tab bar computes its own row-wrap breaks in JS (measuring each tab, reserving room for the
  add-channel button) and re-runs that via a `ResizeObserver` on real size changes. If hovering a
  tab changes its width — e.g. a close button that grows in instead of swapping into the unread
  badge's existing fixed-size slot — that hover-driven resize re-triggers the same
  `ResizeObserver` mid-transition, corrupting the measurement and making the tab flicker between
  rows. Any hover-only affordance here has to be opacity/visibility inside a slot that's already
  reserved at its full size, never a width or margin change. (The `singleRowTabs` preference
  bypasses the measurement entirely -- that branch renders one scrolling row and never wraps --
  but the invariant still holds, since the tabs themselves are shared between both modes.)

## Conventions

- Rust emits fully-resolved data (image URLs, not emote IDs; badge URLs, not badge names) —
  don't push resolution logic that belongs in `render.rs` into a Tauri command or the frontend.
- IPC events are batched (`chat://messages`, 80ms / 200-message flush window in
  `irc/client.rs`) rather than emitted per-message. Preserve this if you add new event types
  for high-frequency data.
- Frontend types in [src/types.ts](src/types.ts) are hand-mirrored from the Rust structs they
  correspond to (no codegen). Update both sides together.
- Preferences live in `settings.json` (`settings::Preferences`), read once at startup and written
  whole on every change. That struct is `rename_all = "camelCase"` because it crosses to the
  frontend as-is; the fields around it in `Settings` predate that and stay snake_case. Rust
  deliberately doesn't validate values -- the store normalizes an unknown one back to the default,
  so a hand-edited file can't wedge the UI. Add settings there, not to `localStorage`, which is
  only the fallback for mock mode.
- Whether a message is *about you* -- a mention, a reply to you -- is decided in the frontend
  ([src/lib/mentions.ts](src/lib/mentions.ts)), not in `render.rs`. It depends on which login is
  reading, which is now a per-*tab* question and changes without the already-resolved backlog
  being rebuilt: pass the tab's account login, never a single app-wide one. Same for the chatter
  list behind `@` completion: session-only frontend state, since Twitch gives a plain chat client
  no roster to read.
- **Emote blacklists are matched in the frontend for the same reason**
  ([src/lib/emoteBlacklist.ts](src/lib/emoteBlacklist.ts)). Rust only persists the two rule lists
  in `Preferences`; whether an emote draws as an image or as its underlined name is decided at
  render time in `EmoteView`. Blacklisting from the chat context menu has to repaint the messages
  already on screen, and those are resolved and immutable by then -- filtering in `render.rs`
  would only affect messages that arrive afterwards. `EmoteView` subscribes to the list through
  the store rather than taking a prop, because `MessageRow` is memoized on message identity and a
  prop would never reach a row that's already rendered.
- **The chat-command catalog lives in the frontend, the execution in Rust** --
  [src/lib/commands.ts](src/lib/commands.ts) and
  [src-tauri/src/twitch/commands.rs](src-tauri/src/twitch/commands.rs). Same reasoning as the
  emote blacklists: usage, description and required scope are read on every keystroke by the `/`
  picker, and what they're used for (can I run this?) depends on the granted scopes, which change
  on sign-in without anything being rebuilt. Rust deliberately keeps no scope table -- it calls
  Helix and surfaces Twitch's own refusal -- so the two can only disagree in the safe direction.
  Adding a command means both files.
- The bundle identifier is `io.github.chetwow.chatwow`. Leave it alone unless the move is
  deliberate -- changing it relocates the app config dir and orphans the stored tokens,
  channels and preferences, for every install rather than just yours.
- Emote ranking is split on purpose: Rust owns the inventory and persists the use counts
  (`emote_uses` in `settings.json`), the frontend applies the ordering at match time
  ([src/lib/emoteComplete.ts](src/lib/emoteComplete.ts)). That keeps Tab and the `:` picker
  synchronous — neither waits on IPC mid-keystroke.
- [src/lib/emoji.json](src/lib/emoji.json) is generated, not authored. Change
  `scripts/generate-emoji.py` and re-run it.
- No client secret is ever used or stored — this app is a public OAuth client (device code
  flow). Don't add a flow that requires one.
- When writing Rust files containing literal backslashes (e.g. char literals like `'\\'`),
  use the Write tool, not a bash heredoc — heredocs have mangled `\\` into `\` in this repo
  before, producing an unterminated character literal.
- **Outgoing messages are sent via Helix, not raw IRC, and never rendered locally.**
  `send_message` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) calls
  `POST /helix/chat/messages` ([src-tauri/src/twitch/chat.rs](src-tauri/src/twitch/chat.rs)),
  which requires the `user:write:chat` scope ([src-tauri/src/auth.rs](src-tauri/src/auth.rs)).
  Twitch broadcasts a sent message back to the sender's own IRC connection exactly like any other
  channel message, so it renders through the normal incoming-PRIVMSG path — don't add a local
  echo in `send_message`, that renders it a second time (this was a real bug: messages appeared
  twice). Helix is used specifically because it hands back the real id Twitch assigned the
  message in its response; raw IRC never echoes that id to the sender, and a reply's
  `reply-parent-msg-id` (including a reply to one of your *own* messages) has to reference an id
  Twitch actually issued.

## Out of scope

A dedicated whisper view, searching chat history — see
[README.md](README.md#not-supported-yet) for current status before adding these.
