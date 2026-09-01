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
python3 scripts/generate-emoji.py   # regenerate src/lib/emoji.json (don't hand-edit it)
```

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

Mock mode sets `auth.login` to `you` while leaving `loggedIn` false, so the reply-to-you and
mention highlights have an identity to match against; some mock drafts tag `@you` and use the
bare name deliberately. Preferences fall back to `localStorage` there, since there's no backend
to write `settings.json`.

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
  ([src/lib/mentions.ts](src/lib/mentions.ts)), not in `render.rs`. It depends on the signed-in
  login, which changes on sign-in/out without the already-resolved backlog being rebuilt. Same
  for the chatter list behind `@` completion: session-only frontend state, since Twitch gives a
  plain chat client no roster to read.
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
