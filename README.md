# ChatWow

A desktop Twitch chat client built with Tauri 2 and React. Multiple channels in a tabbed
interface, rendered the way Twitch renders them: native Twitch emotes, 7TV global and channel
emotes (including zero-width overlays), user badges, and correct name colors. Signed-in users
can send messages, including `/me` actions, run Twitch's slash commands from a `/` picker, and
get Tab completion for emotes and chatter names, a `:` emote/emoji search, message history in the
composer, and mention highlighting with an optional ping.

## Running it

```bash
npm install
npm run tauri dev
```

## Signing in (optional)

Chat, emotes, and name colors all work anonymously. **Badge images** are the exception: Twitch
retired the old public `badges.twitch.tv` endpoint, so badge art now comes from the
authenticated Helix API. Without a sign-in, badges render as small text chips instead.

For users, that's one click: **Sign in** in the title bar, approve the device code in the
browser, done. No dev console, no account setup beyond their normal Twitch login. Signing in
is also required to send messages -- the composer is read-only text otherwise.

### Permissions

Twitch grants scopes once, on the consent screen, and there's no way to escalate later without
going through the whole flow again -- so what to ask for is a choice made *before* signing in, in
Settings -> Account. Reading and sending chat is always requested, and so is **Your own account**
-- `/color`, `/block` and `/w` act on your account alone and can't reach a channel, so there's
nothing to weigh up and no box to untick. **Moderator commands** and **Broadcaster commands** are
off until you tick them, and each group's tooltip says which commands it unlocks. Ticking a box asks for more next time: it can't upgrade
the token you're holding, so the panel says so and offers the button. Granting moderator scopes
doesn't make you a moderator anywhere -- Twitch still checks that you are one, channel by channel.

The groups are defined in [`src-tauri/src/auth.rs`](src-tauri/src/auth.rs)
(`PERMISSION_GROUPS`); what a token actually carries comes back from `/oauth2/validate` and is
what decides whether a command can run.

### The Client ID

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

Users get the same escape hatch at runtime under Settings -> Account -> *Use a different Client
ID*, which exists for the case the built-in one can't cover: the shipped Twitch app being
suspended or rate-limited, where the alternative would be waiting for a new release. It's stored
under its own settings key, so an override only ever exists because someone deliberately set one
in this build -- a file left behind by an earlier build can't silently redirect the app. Changing
it signs you out, since Twitch issues a token against one specific Client ID.

No client secret is ever needed or stored. Tokens live in `settings.json` under the app's
config directory and are refreshed automatically.

## Architecture

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

### Sending messages

Outgoing messages go through Twitch's Helix `POST /helix/chat/messages` API rather than a raw
IRC `PRIVMSG` (requires the `user:write:chat` scope). Helix is the only place Twitch hands back
the real id it assigns a sent message, which a reply needs to reference via
`reply-parent-msg-id` -- including a reply to one of your *own* messages. There's no local echo:
Twitch broadcasts a sent message back to the sender's own IRC connection exactly like any other
channel message, so it renders through the normal incoming-message pipeline, with real emote,
badge, and reply-quote resolution identical to everything else.

### Chat commands

Twitch stopped accepting chat commands over IRC in 2023 -- sending `/ban someone` as a `PRIVMSG`
posts those eleven characters as a message -- so every command is a Helix call. Typing `/` opens
a picker listing them with their arguments; `↑`/`↓` moves, `Tab` completes, `Enter` takes the
highlighted one (or runs it, if you've already typed the name in full), `Esc` closes. Once you're
past the name a hint bar keeps the command's arguments in front of you.

The list is filtered to what you could actually run where you're typing: no moderator commands
unless you're a moderator in that channel, no broadcaster commands unless it's yours. That comes
from your own `USERSTATE`, which Twitch sends on join -- there's no Helix endpoint that answers
"am I a moderator in someone else's channel", so the tag is the only source. A channel that
hasn't answered yet reads as viewer, which errs towards offering too little rather than offering
something Twitch will refuse. Commands you're only missing a *permission* for do stay listed,
marked, since that one you can act on. `/help` ignores the filter and lists everything.

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

### Replies

Right-clicking a message offers Copy and Reply. Reply opens a bar above the composer showing
what you're replying to (Escape or its close button cancels); sending threads the message via
Helix's `reply_parent_message_id`, and Twitch's own `reply-parent-*` tags on the resulting
`PRIVMSG` are what render the "Replying to ..." quote on both ends.

### Mentions

A message that names you -- `@yourname` or just `yourname`, case-insensitively and only as a
whole word, so `youtube` doesn't count -- gets the same rose highlight as a reply to you, and
plays a short two-tone ping ([src/lib/notify.ts](src/lib/notify.ts) synthesizes it with the Web
Audio API rather than shipping an audio file). Your own messages never match, so saying your own
name doesn't light up the line you just sent. One batch of messages pings at most once, and no
more often than every 1.5s.

Which mentions ping is set in Settings -> Notifications: `@` tags and bare-name uses are separate
toggles, so you can keep one and drop the other, and a third decides whether the channel you're
currently reading pings at all -- off by default, since you can already see the mention land. The
speaker button in the title bar is a quick mute over all of them that leaves the toggles as you
set them. Highlights and badges are unaffected by every one of these -- the quiet half of a
mention always happens.

Mentions are counted per channel alongside unread, and a tab holding any turns its unread badge
from accent to rose -- so an inactive tab distinguishes "chat moved" from "chat is talking to
you" at a glance. Reading the channel clears both. The badge only changes color, never size --
the tab bar measures its own row wrapping, so a tab's rendered width has to stay put.

### Message history

`↑` in the composer walks back through what you've sent in the current channel, `↓` comes
forward again; stepping past the newest entry restores whatever you'd half-typed when the walk
started, and typing over a recalled message ends the walk so the next `↑` starts from the top.
History is per channel and lives only for the session, and a repeat of the previous message
doesn't add a second entry. The emote picker takes the arrows first while it's open.

### Emote completion and search

Two ways to get an emote into a message, both fed by the same per-channel index (7TV global and
channel sets, plus Twitch's global and channel emotes from Helix):

- **Tab** completes the half-typed word at the caret: matching emotes first, then the chatters
  whose name starts the same way. Pressing it again cycles the other matches, Shift+Tab goes
  back, and it wraps around. No picker opens and no emoji are offered -- this is the path for
  when you already know what you're typing. Tab on an empty word does nothing.
- **`:`** at the start of a word opens a scrollable picker. With nothing typed it lists your
  most-used emotes. Once there are letters, emotes whose name *starts* with them come first and
  emotes that merely contain them follow — so an exact prefix is never buried under a coincidental
  substring hit, but a mid-name match is still reachable. Emoji join the results once letters are
  typed and rank below every emote, including emoji that do start with what you typed. The quick
  Tab complete stays prefix-only: it has no list to look at, so a surprise substring match would
  be hard to predict. Arrows move the selection, Tab or Enter takes it, Escape closes the picker.

A word starting with `@` completes to a chatter and nothing else, inserting `@name, ` -- the comma
because what follows is usually either another name or the message itself. The plain-word Tab
above inserts the bare name with just a space, which is what reads correctly mid-sentence.

Chatter names are matched against both login and display name, ordered alphabetically, and always
inserted with the display name's own casing. The candidate list is built from incoming messages
and lasts only for the session: Twitch gives a plain chat client no roster to read, and a stale
name is worse than a missing one when you're replying to someone. You're never in your own list.

Both order their *emote* matches by how often you've sent each one, falling back to alphabetical
(chatter names are only ever alphabetical -- there are no counts to rank them by). Counts are per
emote name across every channel, kept in `settings.json`, and every emote in a sent message
counts — not just the completed ones.

Twitch's own emotes are fetched from Helix purely to populate this index. They're deliberately
kept out of the maps that render incoming messages: an incoming message's `emotes` tag already
identifies its Twitch emotes by id, and matching on name instead would render any word that
happens to match an emote name as that emote, even from someone who doesn't own it.

Emoji come from a generated list of ~1,900 Unicode names
(`scripts/generate-emoji.py` → `src/lib/emoji.json`), dynamically imported so it stays out of the
initial bundle. Picking one inserts the literal character — Twitch doesn't expand `:shortcode:`.

### Emote images on disk

Emote images are cached under the app's cache directory and served to the webview over an
`emote://` scheme handled in Rust, so a busy channel stops re-fetching the same emotes. Files are
keyed by **provider id, not name** — 7TV emotes are aliased per channel, so a name is neither
stable nor unique. The cache fills lazily (an emote is stored the first time it's actually
displayed), and a miss or failure falls back to the CDN url. Images that no joined channel can
reach any more are purged once every channel's set has loaded.

### Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/src/irc/parse.rs` | IRCv3 line + tag parser |
| `src-tauri/src/irc/client.rs` | WebSocket connection, reconnect, per-channel asset loading |
| `src-tauri/src/render.rs` | Emote ranges, overlay folding, badge and segment resolution |
| `src-tauri/src/color.rs` | Twitch default color palette + dark-background readability lift |
| `src-tauri/src/emotes/seventv.rs` | 7TV v3 global and channel emote sets |
| `src-tauri/src/emotes/cache.rs` | On-disk emote images, served over `emote://` |
| `src-tauri/src/twitch/badges.rs` | Helix global and channel badges |
| `src-tauri/src/twitch/emotes.rs` | Helix emote names, for completion only |
| `src-tauri/src/auth.rs` | OAuth device code flow |
| `src-tauri/src/settings.rs` | `settings.json`: tokens, channels, emote counts, preferences |
| `src/store/chat.ts` | Zustand store, per-channel 500-message ring buffer |
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
fallbacks, the default color hash, emote-index ordering and use counting, and the image cache's
key validation, content-type sniffing and purge selection.

## Settings

The gear in the title bar opens a tabbed dialog -- Account (Twitch sign-in, the permissions to
ask for, and the Client ID),
Appearance (chat font size) and Notifications (the mention toggles above; the title bar keeps the
mute). The account button in the title bar opens the same dialog on its Account tab, which is the
only sign-in surface. It's sized for the window's 420px minimum: the panel is `min(560px, 100%)`,
setting rows wrap their control under the label when they have to, and the tab row scrolls
sideways rather than wrapping to a second row that would push content off the bottom. Its height is fixed to the window rather than the
content, so switching tabs doesn't resize it. Each setting's explanation sits behind the info dot
on its label -- hover or focus it -- which keeps the list scannable.

Preferences live in `settings.json` next to the tokens and channel list -- `Preferences` in
[src-tauri/src/settings.rs](src-tauri/src/settings.rs), mirrored by the `Preferences` type in
[src/types.ts](src/types.ts), read at startup and written whole on every change. The font-size
preset resolves to a `--chat-font-size` custom property set on the app root; only message bodies
and the composer follow it, so nothing that measures its own layout moves when it changes. Mock
mode has no backend to write to and falls back to `localStorage`.

## Shortcuts

- `Ctrl+K` — join a channel
- `Tab` — complete the word you're typing to an emote or a chatter; again to cycle, `Shift+Tab`
  to go back
- `@` + `Tab` — complete a chatter's name only, inserted as `@name, `
- `:` — open the emote and emoji search; `↑`/`↓` to move, `Tab`/`Enter` to take, `Esc` to close
- `/` — open the command picker, same keys
- `↑`/`↓` — step back and forward through your sent messages in this channel
- `Esc` — cancel a reply

## Not supported yet

BTTV/FFZ emotes, receiving whispers (`/w` sends; replies arrive on Twitch, not here), and
searching chat history.
