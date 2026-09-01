# Architecture

How ChatWow is put together, and why the awkward parts are the way they are.
[README.md](README.md) describes the app from a user's side; [CLAUDE.md](CLAUDE.md) is the
short list of rules to work by. This file is the long form: what talks to what, and which
decisions have a reason behind them that isn't visible in the code.

## The Rust/React boundary

The IRC connection, asset fetching, and message resolution all live in Rust; React only renders.

```
Twitch IRC (wss)  ─┐
7TV v3 API        ─┼─→ Rust: parse → resolve → "chat://messages" ─→ React store → render
Helix badges API  ─┘
```

The backend emits **fully resolved** messages — badges already mapped to image URLs, message
text already split into text/emote/mention/link segments. Two things make this worth doing in
Rust rather than the webview:

- Twitch's `emotes` tag indexes by Unicode **code point**. Byte or UTF-16 indexing corrupts any
  message containing non-BMP characters (emoji, most notably).
- 7TV overlay emotes have to be folded onto the emote before them, which is easier to get right
  and to unit-test in one place.

Messages are batched every 80ms before crossing the IPC bridge, which is what keeps a
high-traffic channel from swamping the UI.

Not everything belongs behind that line. Whether a message names you, which emotes are
blacklisted, and what the `/` picker offers are all decided in the frontend, because each
depends on state that changes without the already-resolved backlog being rebuilt — the
signed-in login, an edited rule list, the scopes a token carries.

## Chat backlog on join

Joining a channel shows the last 150 messages rather than an empty pane. Twitch has no chat
history for third-party clients -- their own site reads it from an internal endpoint -- so this
comes from [recent-messages.robotty.de](https://recent-messages.robotty.de), the open-source
service Chatterino uses: it runs a bot that joins the channels its users ask about and keeps the
last few hundred lines.

It answers with *raw IRC lines*, tagged `historical=1`, which is what makes it cheap here --
[`src-tauri/src/irc/history.rs`](src-tauri/src/irc/history.rs) hands them to the same parser,
emote resolution and renderer as the live socket, so a replayed message is indistinguishable from
one that just arrived except for the flag. That flag matters: a backlog isn't news, so it never
pings, reddens a tab or counts as unread, however recently it was said.

Two details it's easy to get wrong. The fetch happens *before* the channel is marked ready, so
live messages keep buffering and the backlog can be placed above them rather than under them.
And the history runs up to now while the buffer starts partway through it, so the two overlap by
however long the fetches took -- Twitch's message ids settle that exactly.

Worth knowing: it's one volunteer's server, so a failure is a non-event (no backlog, not a broken
join), and asking it about a channel tells it you joined that channel -- the one thing this app
does that Twitch and 7TV don't see. Users can opt out of being recorded at
<https://www.twitch.tv/recent_messages>, and Settings -> General -> *Show recent message history
on join* turns it off here, after which the app only ever talks to Twitch and 7TV.

## Sending messages

Outgoing messages go through Twitch's Helix `POST /helix/chat/messages` API rather than a raw
IRC `PRIVMSG` (requires the `user:write:chat` scope). Helix is the only place Twitch hands back
the real id it assigns a sent message, which a reply needs to reference via
`reply-parent-msg-id` -- including a reply to one of your *own* messages. There's no local echo:
Twitch broadcasts a sent message back to the sender's own IRC connection exactly like any other
channel message, so it renders through the normal incoming-message pipeline, with real emote,
badge, and reply-quote resolution identical to everything else.

Replies thread through Helix's `reply_parent_message_id`, and Twitch's own `reply-parent-*` tags
on the resulting `PRIVMSG` are what render the "Replying to ..." quote on both ends.

## Chat commands

Twitch stopped accepting chat commands over IRC in 2023 -- sending `/ban someone` as a `PRIVMSG`
posts those eleven characters as a message -- so every command is a Helix call.

The picker's list is filtered to what you could actually run where you're typing: no moderator
commands unless you're a moderator in that channel, no broadcaster commands unless it's yours.
That comes from your own `USERSTATE`, which Twitch sends on join -- there's no Helix endpoint
that answers "am I a moderator in someone else's channel", so the tag is the only source. A
channel that hasn't answered yet reads as viewer, which errs towards offering too little rather
than offering something Twitch will refuse. Commands you're only missing a *permission* for do
stay listed, marked, since that one you can act on. `/help` ignores the filter and lists
everything.

The split: [`src-tauri/src/twitch/commands.rs`](src-tauri/src/twitch/commands.rs) maps each
command to its endpoint, arguments to query and body, and the response to the line printed back
into the channel. The catalog the picker reads -- usage, description, which permission each
command needs -- is [`src/lib/commands.ts`](src/lib/commands.ts), for the same reason mentions
and emote blacklists are decided in the frontend: it depends on the granted scopes, which change
on sign-in with nothing rebuilt, and the picker has to answer on every keystroke without a round
trip. A failed command keeps your text in the composer, since the usual cause is an argument to
fix; a successful one prints what it did as a notice.

`/me` is the exception: it's a message rather than a command and goes out through the send path
like any other text.

`/mods` and `/vips` only work in your own channel, unlike Twitch's own chat: Helix's Get
Moderators and Get VIPs both require the `broadcaster_id` to match the user in the token, and
there's no public endpoint for anyone else's list. Twitch's web client reads it from an internal
API this app can't use.

## Whispers

Whispers arrive on a second socket: Twitch doesn't deliver them over IRC at all, so
[`src-tauri/src/twitch/eventsub.rs`](src-tauri/src/twitch/eventsub.rs) holds an EventSub
WebSocket subscribed to `user.whisper.message` (the *Your own account* permission covers it) and
feeds the same batching sink the chat connection uses. EventSub sends the sender and the text and
nothing else -- no emote ranges, no badges, no color -- so a whisper resolves 7TV globals, links
and mentions from its text, the name gets the usual palette color, and there are no badges to
draw. It carries no channel either, so Rust sends an empty one and the store files it under
whichever channel you're reading -- only the frontend knows which that is.

A whisper always pings unless you're muted, since unlike a mention in the channel you're already
reading, it arrived from outside the room.

## Permissions and scopes

Twitch grants scopes once, on the consent screen, and there's no way to escalate later without
going through the whole flow again -- so what to ask for is a choice made *before* signing in.
The groups are defined in [`src-tauri/src/auth.rs`](src-tauri/src/auth.rs)
(`PERMISSION_GROUPS`); what a token actually carries comes back from `/oauth2/validate` and is
what decides whether a command can run. Those two are deliberately separate values on
`AuthStatus`: a UI that reads the ticked boxes as capability will claim commands work that
Twitch will refuse.

Granting moderator scopes doesn't make anyone a moderator -- Twitch still checks that, channel
by channel, on every call.

## The Client ID

Every build has one. [`src-tauri/build.rs`](src-tauri/build.rs) supplies the app's own Client ID
whenever `TWITCH_CLIENT_ID` isn't set, so a plain `npm run tauri build` produces a working binary
and no build can reach a user asking them to go and register a Twitch app.

A Client ID is a *public* identifier, not a secret -- it travels in the clear on every OAuth
request, so committing it and shipping it inside the binary is its intended use. The client
*secret* is the confidential half, and the device code flow never needs one. That's why the app
is registered with **Client Type: Public** at <https://dev.twitch.tv/console/apps> (OAuth
Redirect URL `http://localhost:3000`, required at registration but unused by device flow).

To build against a different Twitch app -- testing, or a fork:

```bash
TWITCH_CLIENT_ID=your_client_id npm run tauri build
```

The runtime override under Settings -> Account exists for the case the built-in one can't cover:
the shipped Twitch app being suspended or rate-limited, where the alternative would be waiting
for a new release. It's stored under its own settings key, so an override only ever exists
because someone deliberately set one in this build -- a file left behind by an earlier build
can't silently redirect the app. Changing it clears the session, since Twitch issues a token
against one specific Client ID and one held across a switch reads as a broken session rather
than a signed-out one.

No client secret is ever needed or stored. Tokens live in `settings.json` under the app's
config directory and are refreshed automatically.

## Mentions

A message that names you -- `@yourname` or just `yourname`, case-insensitively and only as a
whole word, so `youtube` doesn't count -- gets the same rose highlight as a reply to you, and
plays a short two-tone ping ([src/lib/notify.ts](src/lib/notify.ts) synthesizes it with the Web
Audio API rather than shipping an audio file). Your own messages never match, so saying your own
name doesn't light up the line you just sent. One batch of messages pings at most once, and no
more often than every 1.5s.

Mentions are counted per channel alongside unread, and a tab holding any turns its unread badge
from accent to rose. The badge only changes color, never size -- see below.

## Tabs

The tab bar computes its own row wrapping in JS, measuring each tab and reserving room for the
add-channel button, and re-runs that from a `ResizeObserver`. That makes a tab's rendered width
load-bearing: anything that changes it on hover (or when a channel finishes loading, or goes
live) re-triggers the observer mid-transition, corrupts the measurement, and flickers a tab
between rows. Hence the fixed-size slots -- the close button shares the unread badge's, the
status dot's is reserved whether or not a dot is in it.

The single-row mode ([src/components/TabBar.tsx](src/components/TabBar.tsx), behind the
`singleRowTabs` preference, and the default) skips that measurement entirely and clears any
breaks left from wrap mode, and its observer is rebuilt on the toggle -- switching back mounts a
row element the original observer never saw. Its scrollbar is styled through
`::-webkit-scrollbar` alone: the
standard `scrollbar-width`/`scrollbar-color` pair has no hover state to hook, and setting either
makes Chromium ignore the pseudo-element rules entirely (`scrollbar-width: none` hides the bar
outright). The 6px gutter is reserved whether or not a thumb is drawn, since a bar that grew on
hover would shift the whole chat pane.

A rose mention badge that scrolls out of the row is the one thing the bar can't otherwise show
you, so the edge it's past gets a marker. It's anchored to the tab bar rather than the scroller
-- an absolute child of a scroll container is part of what scrolls, and would slide off the edge
it marks -- and positions come from `getBoundingClientRect`, since a tab's `offsetParent` sits
outside the scroller and its offsets don't move as the row does. The check is keyed on which
channels have mentions rather than on the mentions map, which is a fresh object on every batch.

`Ctrl/Cmd+W` closing a tab is why the macOS menu bar is built by hand
([`macos_menu`](src-tauri/src/lib.rs)): Tauri's default menu binds `Cmd+W` to Close Window, and
a menu key equivalent is matched before the keystroke ever reaches the webview.

## Message history

`↑` in the composer walks back through what you've sent in the current channel, `↓` comes
forward again; stepping past the newest entry restores whatever you'd half-typed when the walk
started, and typing over a recalled message ends the walk so the next `↑` starts from the top.
History is per channel and lives only for the session, and a repeat of the previous message
doesn't add a second entry. The emote picker takes the arrows first while it's open.

## Emote completion and search

Both entry points -- `Tab` and the `:` picker -- are fed by the same per-channel index (7TV
global and channel sets, plus Twitch's global and channel emotes from Helix).

The `:` picker ranks an exact prefix above a coincidental substring hit, so a name that merely
contains what you typed is reachable without burying the one that starts with it. Emoji join the
results once letters are typed and rank below every emote, including emoji that do start with
what you typed. Tab completion stays prefix-only: it has no list to look at, so a surprise
substring match would be hard to predict.

Chatter names are matched against both login and display name, ordered alphabetically, and always
inserted with the display name's own casing. The candidate list is built from incoming messages
and lasts only for the session: Twitch gives a plain chat client no roster to read, and a stale
name is worse than a missing one when you're replying to someone. You're never in your own list.

Both order their *emote* matches by how often you've sent each one, falling back to alphabetical
(chatter names are only ever alphabetical -- there are no counts to rank them by). Counts are per
emote name across every channel, kept in `settings.json` by Rust while the frontend applies the
ordering at match time, which is what keeps Tab and the picker synchronous -- neither waits on
IPC mid-keystroke. Every emote in a sent message counts, not just the completed ones.

Twitch's own emotes are fetched from Helix purely to populate this index. They're deliberately
kept out of the maps that render incoming messages: an incoming message's `emotes` tag already
identifies its Twitch emotes by id, and matching on name instead would render any word that
happens to match an emote name as that emote, even from someone who doesn't own it.

Emoji come from a generated list of ~1,900 Unicode names
(`scripts/generate-emoji.py` → `src/lib/emoji.json`), dynamically imported so it stays out of the
initial bundle. Picking one inserts the literal character — Twitch doesn't expand `:shortcode:`.

## Emote images on disk

Emote images are cached under the app's cache directory and served to the webview over an
`emote://` scheme handled in Rust, so a busy channel stops re-fetching the same emotes. Files are
keyed by **provider id, not name** — 7TV emotes are aliased per channel, so a name is neither
stable nor unique. The cache fills lazily (an emote is stored the first time it's actually
displayed), and a miss or failure falls back to the CDN url. Images that no joined channel can
reach any more are purged once every channel's set has loaded -- purging on a partial picture
would evict images the other channels are about to ask for.

## Settings

Preferences live in `settings.json` next to the tokens and channel list -- `Preferences` in
[src-tauri/src/settings.rs](src-tauri/src/settings.rs), mirrored by the `Preferences` type in
[src/types.ts](src/types.ts), read at startup and written whole on every change. Rust
deliberately doesn't validate the values: the store normalizes an unknown one back to the
default, so a hand-edited file can't wedge the UI. The font-size preset resolves to a
`--chat-font-size` custom property set on the app root; only message bodies and the composer
follow it, so nothing that measures its own layout moves when it changes. Mock mode has no
backend to write to and falls back to `localStorage`.

The dialog is sized for the window's 420px minimum: the panel is `min(560px, 100%)`, setting rows
wrap their control under the label when they have to, and the tab row scrolls sideways rather
than wrapping to a second row that would push content off the bottom. Its height is fixed to the
window rather than the content, so switching tabs doesn't resize it. Each setting's explanation
sits behind the info dot on its label, which keeps the list scannable.

## Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/src/irc/parse.rs` | IRCv3 line + tag parser |
| `src-tauri/src/irc/client.rs` | WebSocket connection, reconnect, per-channel asset loading |
| `src-tauri/src/irc/history.rs` | The recent-messages backlog fetched on join |
| `src-tauri/src/render.rs` | Emote ranges, overlay folding, badge and segment resolution |
| `src-tauri/src/color.rs` | Twitch default color palette + dark-background readability lift |
| `src-tauri/src/emotes/seventv.rs` | 7TV v3 global and channel emote sets |
| `src-tauri/src/emotes/cache.rs` | On-disk emote images, served over `emote://` |
| `src-tauri/src/twitch/badges.rs` | Helix global and channel badges |
| `src-tauri/src/twitch/emotes.rs` | Helix emote names, for completion only |
| `src-tauri/src/twitch/commands.rs` | Every slash command, as its Helix call |
| `src-tauri/src/twitch/eventsub.rs` | The whisper socket |
| `src-tauri/src/auth.rs` | OAuth device code flow, permission groups |
| `src-tauri/src/settings.rs` | `settings.json`: tokens, channels, emote counts, preferences |
| `src/store/chat.ts` | Zustand store, per-channel 500-message ring buffer |
| `src/lib/commands.ts` | The command catalog the `/` picker reads |
| `src/lib/emoteComplete.ts` | Completion cycling, picker search and ranking |
| `src/lib/chatterComplete.ts` | Chatters seen this session, matched for `@` and Tab |
| `src/lib/mentions.ts` | Whether (and how) a message names the signed-in user |
| `src/lib/notify.ts` | The synthesized mention ping |
| `src/lib/emoji.ts` | Lazy-loaded emoji list and name search |
| `src/components/` | Title bar, tabs, chat view, composer, picker, settings |
| `scripts/generate-emoji.py` | Regenerates `src/lib/emoji.json` from Unicode |

## Tests

```bash
cd src-tauri && cargo test
```

Covers tag unescaping, code-point emote ranges, zero-width overlay folding, badge lookup
fallbacks, the default color hash, emote-index ordering and use counting, command argument
parsing, the backlog's filtering, and the image cache's key validation, content-type sniffing and
purge selection. `cargo test -- --ignored` additionally hits the real Twitch and 7TV APIs.

The frontend has no test suite; `npm run build` type-checks it.
