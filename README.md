# ChatWow

A desktop Twitch chat client. Read and write several channels at once, with chat rendered the
way Twitch renders it: native Twitch emotes, 7TV global and channel emotes (zero-width overlays
included), user badges, and everyone's real name color.

- Tabs for as many channels as you like, wrapped onto rows or scrolling on one
- Recent messages on join, so a channel is never a blank pane
- Mention highlighting, per-channel unread counts, and an optional ping
- Twitch's slash commands from a `/` picker that only offers what you can run
- Whispers, replies, `Tab` completion for emotes and names, and a `:` emote and emoji search

## Running it

```bash
npm install
npm run tauri dev
```

## Signing in

Chat, emotes and name colors all work signed out. Two things need an account: sending messages,
and badge art -- Twitch retired the old public badge endpoint, so without a sign-in badges show
as small text chips instead of pictures.

Signing in is one click: **Sign in** in the title bar, then approve the code in the browser tab
it opens. No developer console, no setup beyond your normal Twitch login, and no password is
ever typed into this app.

### Permissions

Twitch asks for permissions once, on its consent screen, and there's no way to add more later
without signing in again -- so you choose what to ask for *before* you sign in, in
Settings -> Account.

| Group | What it's for |
| --- | --- |
| Read and send chat | Always asked. It's what signing in is for. |
| Your own account | `/color`, `/block`, `/unblock` and whispers. Always asked -- these act on your account alone, and can't reach a channel. |
| Moderator commands | `/ban`, `/timeout`, `/clear`, `/slow`, `/announce` and the rest. |
| Broadcaster commands | `/mod`, `/vip`, `/raid`, `/commercial` and `/marker`. |

Ticking a box changes what the *next* sign-in asks for -- it can't add anything to the account
you're already signed into, so the panel offers you the button to sign in again. Asking for the
moderator permissions doesn't make you a moderator anywhere: Twitch still checks that channel by
channel.

If you'd rather use your own Twitch app's Client ID, Settings -> Account takes one. It's there
for the day the built-in one is rate-limited or suspended; changing it signs you out, since a
Twitch token belongs to one specific app.

## Channels and tabs

`Ctrl/Cmd+T` (or the `+` button) joins a channel, `Ctrl/Cmd+W` leaves the one you're reading,
and tabs reorder by dragging. A tab shows a dot while it's still loading, a red one while the
channel is live, and an unread count once you look away -- in rose rather than purple when some
of those messages name you.

By default tabs wrap onto as many rows as they need, so everything you've joined is on screen.
Settings -> Appearance -> *Keep tabs on one row* switches to a single row that scrolls sideways
instead, with the join button pinned to the right. If a channel that's mentioned you scrolls out
of sight, the edge it's past shows a rose bar until you scroll back or read it.

## Talking

Type and press Enter. Right-click a message for Copy and Reply; a reply shows what it's
answering above the composer, and Escape cancels it. `/me` italicises a message in your name
color, the way it always has.

`↑` and `↓` in an empty composer walk back and forward through what you've sent in that channel.

### Commands

Typing `/` opens a picker of Twitch's commands with their arguments: `↑`/`↓` moves, `Tab`
completes, `Enter` runs, `Esc` closes. Once you're past the name, a bar keeps the arguments in
front of you.

It only lists what you can actually run where you're typing -- no moderator commands unless
you're a moderator in that channel, no broadcaster commands unless the channel is yours. A
command you're only missing a *permission* for stays listed and says so, since that one you can
fix in Settings. `/help` lists everything.

Two work differently from Twitch's own chat: `/mods` and `/vips` only work in your own channel,
because Twitch's public API has no way to ask about anyone else's.

### Whispers

`/w name message` sends one. Incoming whispers appear in whichever channel you're reading,
marked with a WHISPER chip so they don't read as someone in that channel talking, and they
always ping unless you're muted.

## Emotes

`Tab` completes the word you're typing -- emotes first, then chatters whose name starts the same
way. Press it again to cycle, `Shift+Tab` to go back. A word starting with `@` completes to a
name only.

`:` at the start of a word opens a searchable picker of every emote in the channel plus ~1,900
emoji. With nothing typed it lists your most-used emotes; both it and `Tab` put the ones you use
most at the top.

Right-clicking an emote in chat can hide it: hidden emotes draw as their underlined name instead
of the picture (hover the name to see it anyway), and can be hidden from completion separately.
Both lists are editable in Settings -> Emotes.

## Mentions and pings

A message naming you -- `@yourname` or just your name -- is highlighted, and plays a short ping.
Settings -> Notifications keeps `@` tags and bare-name uses as separate toggles, plus one for
whether the channel you're already reading should ping at all (off by default -- you can see it
land). The speaker button in the title bar mutes the lot without disturbing those toggles;
highlighting and unread counts carry on regardless.

## Settings

The gear in the title bar opens:

- **General** — whether to load a channel's recent messages when you join it
- **Account** — sign in and out, choose permissions, set a Client ID
- **Appearance** — chat font size, and whether tabs wrap or scroll
- **Emotes** — the hidden-emote lists
- **Notifications** — which mentions ping

Every setting explains itself behind the info dot on its label.

Joining a channel asks a third-party service, [recent-messages.robotty.de](https://recent-messages.robotty.de),
for its recent history -- Twitch offers none to apps like this one. That tells them which
channels you read, and it's the only thing this app does that Twitch and 7TV don't see. Turning
off *Show recent message history on join* in General stops it.

## Shortcuts

- `Ctrl/Cmd+T` — join a channel (`Ctrl+K` does the same)
- `Ctrl/Cmd+W` — leave the channel you're reading
- `Tab` — complete the word you're typing to an emote or a chatter; again to cycle, `Shift+Tab`
  to go back
- `@` + `Tab` — complete a chatter's name only, inserted as `@name, `
- `:` — open the emote and emoji search; `↑`/`↓` to move, `Tab`/`Enter` to take, `Esc` to close
- `/` — open the command picker, same keys
- `↑`/`↓` — step back and forward through your sent messages in this channel
- `Esc` — cancel a reply

On macOS the window closes with its own button or `Cmd+Q`, since `Cmd+W` closes a tab here.

## Not supported yet

BTTV/FFZ emotes, a dedicated whisper view (they land in the channel you're reading), and
searching chat history.

## Working on it

It's a Tauri 2 and React app: Rust handles the connection to Twitch, the frontend only draws.
[ARCHITECTURE.md](ARCHITECTURE.md) covers how it fits together and why the awkward parts are the
way they are; [CLAUDE.md](CLAUDE.md) is the working brief for agents.
