# ChatWow

A desktop Twitch chat client. Read and write several channels at once, with chat rendered the
way Twitch renders it: native Twitch emotes, 7TV, BetterTTV and FrankerFaceZ emotes (zero-width
overlays included), user badges, and everyone's real name color.

- Tabs for as many channels as you like, on one scrolling row or wrapped onto several
- Recent messages on join, so a channel is never a blank pane
- Mention highlighting, per-channel unread counts, an optional ping, and an ignore list
- An optional tab collecting every mention, reply and whisper from all channels at once
- Twitch's slash commands from a `/` picker that only offers what you can run
- Whispers, replies, `Tab` completion for emotes and names, and a `:` emote and emoji search
- A card behind every name: account age, follow age, sub months, and what they've said
- Link previews on hover, with Twitch clips, YouTube videos and 7TV emotes read in full
- 7TV emote sets kept live, with a line in chat when one is added, removed or renamed

## Running it

```bash
npm install
npm run tauri dev
```

## Signing in

Chat, emotes and name colors all work signed out. Two things need an account: sending messages,
and Twitch's badge art -- Twitch retired the old public badge endpoint, so without a sign-in
those badges show as small text chips instead of pictures. (7TV badges are unaffected: they come
from 7TV, which doesn't ask who you are.)

Signing in is one click: **Sign in** in the title bar, then approve the code in the browser tab
it opens. No developer console, no setup beyond your normal Twitch login, and no password is
ever typed into this app.

### More than one account

You can sign in more than once, and **every tab reads and sends as one of your accounts**.
Settings -> Accounts lists them: add another with **Add another account**, mark which one new
tabs should use, or sign one out. Signing an account out doesn't close its tabs -- they stay
open and keep reading, without a composer, until you give them an account again.

To change a tab's account, **right-click the tab** (or click the picture beside its message
box) and pick one. The menu also offers **Anonymous**, which reads without sending, and that's
the same list every tab starts from.

Because a tab picks the account rather than the app, the same channel can be open twice --
once as each of you. Both are live at the same time, each with its own composer and its own
unread count, and a message that names one of your logins highlights only in that one's tab. The
tabs stay plain: to see which account one is on, look at the picture beside its message box,
which is the account it sends as.

Permissions and the Client ID below are shared by every account: they're what each sign-in asks
Twitch for, not something one account holds. What Twitch actually *granted* is per account, so
an account signed in before you ticked a box won't have it until you sign it in again.

### Permissions

Twitch asks for permissions once, on its consent screen, and there's no way to add more later
without signing in again -- so you choose what to ask for *before* you sign in, in
Settings -> Accounts.

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

If you'd rather use your own Twitch app's Client ID, Settings -> Accounts takes one. It's there
for the day the built-in one is rate-limited or suspended; changing it signs every account out,
since a Twitch token belongs to one specific app.

## Channels and tabs

`Ctrl/Cmd+T` (or the `+` button) joins a channel, `Ctrl/Cmd+W` leaves the one you're reading,
and tabs reorder by dragging. A tab shows a dot while it's still loading, a red one while the
channel is live, and an unread count once you look away -- in rose rather than purple when some
of those messages name you. Which account a tab reads as is set in the join dialog and changed
by right-clicking the tab.

There's one kind of tab that isn't a channel. Open the join dialog with nothing typed and it
offers **Mentions** as well -- a tab collecting every message that names you, every reply to
something you said, and every whisper, from all your channels at once. It belongs to an account
like any other tab, so with two signed in you can have one of each. Each row is chipped with the
channel it came from; click that chip to go there. It has no composer, since there's no one
channel a message typed into it would belong to. Otherwise it's an ordinary tab: drag it
anywhere in the row, close it like the rest, and it comes back where you left it holding what
arrived while it was shut.

Tabs stay on one row and scroll sideways when there are more than fit, with the join button
pinned to the right. If a channel that's mentioned you scrolls out of sight, the edge it's past
shows a rose bar until you scroll back or read it. Turn off Settings -> Appearance -> *Keep tabs
on one row* and they wrap onto as many rows as they need instead, so everything you've joined is
on screen at once.

A tab can carry a face behind its name, faint enough to read straight through. Right-click a tab
and pick under *Background avatar*: nothing, the channel's own avatar, or the avatar of the
account the tab is on. Settings -> Appearance sets what a *new* tab starts with -- those three,
or the avatar of the account only where the tab isn't on your usual one -- and changing it
leaves the tabs you already have alone. How faint it is is a setting there too. Channel avatars
need you to be signed in; without that those tabs stay plain.

## Two channels at once

The split button in the title bar -- the pane with a line through it -- divides the window in
two: **Split left**, **Split right**, **Split up** or **Split down**, depending on which side
you want the new half. It starts empty, with its own row of tabs and its own join button, and
you fill it by dragging a tab over from the other side or by joining a channel while it's the
half you're working in.

Both halves are live at once: two channels on screen, each with its own composer, each scrolling
on its own. Neither counts as unread while you can see it. Typing anywhere goes to the half you
last clicked in, which is also the one `Ctrl/Cmd+W` closes a tab in and the one a newly joined
channel lands in.

Drag the border between them to give one half more room. The same menu turns a split window
**Side by side** or **Stacked**, swaps the two halves, or puts them back together with **Remove
split** -- which keeps every tab, in the order the two rows were in. A half with no tabs left is
fine and stays open, offering the join button; the split only goes away when you say so, and it
comes back the way you left it next time you open the app.

## Talking

Type and press Enter. You send as the account the tab is on -- the picture beside the message
box says which, and Settings -> Appearance -> *Display your Twitch avatar* takes it away if
you only ever use one -- and a tab with no account reads without sending until you give it one.

Twitch caps a message at 500 characters. Past that the box outlines in red and says how far
over you are, and Enter won't send until it fits.

Right-click a message for Copy and Reply. *Copy* takes the message on its own, or just the part
you've selected if you selected any; *Copy message* takes it the way it reads on screen -- with
the name in front, and the time too if you have timestamps on. A reply shows what it's answering
above the composer, and Escape cancels it. `/me` sends a message in your name color instead of
after your name, italicised unless you'd rather it wasn't.

`↑` and `↓` in an empty composer walk back and forward through what you've sent in that tab.

### Commands

Typing `/` opens a picker of Twitch's commands with their arguments: `↑`/`↓` moves, `Tab`
completes, `Enter` runs, `Esc` closes. Once you're past the name, a bar keeps the arguments in
front of you.

It only lists what you can actually run where you're typing -- no moderator commands unless
you're a moderator in that channel, no broadcaster commands unless the channel is yours. All of
that is asked of the tab's *account*, so the same channel open twice can offer one of you
commands it won't offer the other. A command you're only missing a *permission* for stays listed
and says so, since that one you can fix in Settings. `/help` lists everything.

Two work differently from Twitch's own chat: `/mods` and `/vips` only work in your own channel,
because Twitch's public API has no way to ask about anyone else's.

### Whispers

`/w name message` sends one, from the tab's account. Incoming whispers appear in whichever
channel you're reading *as the account they were sent to*, marked with a WHISPER chip so they
don't read as someone in that channel talking, and they always ping unless you're muted. They
also collect in that account's mentions tab, if it has one.

## Emotes

Emotes come from Twitch itself and from three third-party services: 7TV, BetterTTV and
FrankerFaceZ, each in both its global set and the channel's own. Where two of them ship an emote
under the same name, 7TV's is the one you see. Any of the three can be switched off in
Settings -> Emotes, which stops the app asking that service for anything at all -- its emotes
leave the picker, and words that were drawn as one go back to being words.

`Tab` completes the word you're typing -- emotes first, then chatters whose name starts the same
way. Press it again to cycle, `Shift+Tab` to go back. A word starting with `@` completes to a
name only.

`:` at the start of a word opens a searchable picker of every emote in the channel plus ~1,900
emoji. With nothing typed it lists your most-used emotes; both it and `Tab` put the ones you use
most at the top.

If the channel's 7TV emotes change while you're watching -- one added, removed or renamed -- the
new set is in use straight away, and a line in chat says what changed and who changed it. Turn
the line off in Settings -> Emotes; the emotes still follow the set either way.

Right-clicking an emote in chat can hide it: hidden emotes draw as their underlined name instead
of the picture (hover the name to see it anyway), and can be hidden from completion separately.
Both lists are editable in Settings -> Emotes.

## Badges

Twitch's own badges -- subscriber, moderator, VIP and the rest -- sit before a chatter's name.
Beside them goes the 7TV badge they've equipped, if they have one; those are looked up as people
talk, so a badge can appear a moment after that person's first message. Settings -> Appearance
turns them off, which also stops the app asking 7TV about anyone.

## Chatters

Clicking someone's name opens a card about them: their avatar, when their account was made, how
long they've followed this channel and how many months they've subscribed for -- and under that,
a scrollable log of everything they've said in this channel since the app started. Escape or a
click elsewhere closes it.

Twitch will only answer the first of those, so the follow and subscription lines come from
[ivr.fi](https://api.ivr.fi). When it can't be reached those two rows read *Unavailable* rather
than guessing, and the rest of the card carries on. None of it needs you to be signed in.

## Links

Links in chat are clickable, and hovering one shows what's behind it. A link pointing straight at
an image previews as that image. Any other link previews as what the page says about itself --
its title, its thumbnail and its own one-line summary, the same things that make a link unfurl in
Slack or Discord. A YouTube video adds the channel, the duration, when it went up, and its view
and like counts.

Twitch's own links get more, since the app can ask Twitch directly. A clip shows who was
streaming, who clipped it, the game, its length and its views; a VOD shows the channel, length,
views and date; a channel shows what they're playing, how many are watching and how long they've
been live, or their bio and what they last streamed if they're off. That half needs you signed
in -- Twitch answers none of it anonymously -- and falls back to the ordinary page preview when
you're not.

Nothing is fetched until the pointer has rested on the link for a moment, so reading past a
message costs nothing, and a spinner marks the wait while a preview loads. A page that publishes
nothing about itself simply has no preview.

A link to a **7TV emote** previews as the emote itself, at full size, with its name and who made
it -- 7TV is asked directly, so it works whether or not you're signed in.

Two switches in Settings -> General, for the two kinds of promise:

- *Preview image links* — a picture: the image a link points at, or the emote behind a 7TV emote link
- *Preview other links* — everything else, which means asking that page (or Twitch) about itself

## Losing the connection

If the connection to Twitch drops, every channel you're reading says so rather than just going
quiet, and says so again when it's back -- along with how many messages it recovered from the
gap. Those are fetched the same way the backlog on join is, so switching *Show recent message
history on join* off in Settings leaves you the line without the messages.

Recovered messages read like any other, mention highlighting included, but they don't ping or
count towards a tab's unread badge. Like the backlog on join, they're drawn slightly dimmed --
the point where that stops is the point where chat starts being live.

## Mentions and pings

A message naming you -- `@yourname` or just your name -- is highlighted, and plays a short ping.
"You" is per tab: it's the name of the account that tab reads as, so with the same channel open
twice a message naming one of your logins lights up in that tab alone.

Settings -> Notifications keeps `@` tags and bare-name uses as separate toggles, plus one for
whether the channel you're already reading should ping at all (off by default -- you can see it
land). The speaker button in the title bar mutes the lot without disturbing those toggles;
highlighting and unread counts carry on regardless. Those toggles, and the two lists below, are
shared by every account.

Right-click anyone's message for two ways to hear less from them. **Ignore mentions from
<name>** leaves them able to talk to you but stops the app telling you about it: no sound, no
rose badge, and nothing in the mentions tab. **Block <name>** goes further and stops drawing
their messages at all, in every channel. Neither is sent to Twitch -- both are between you and
this app, and undoing either brings everything straight back, including the messages already
scrolled past.

The ignore list lives in Settings -> Notifications and takes both kinds of entry: `@name`
silences one person wherever they turn up, `#name` silences a whole channel. Blocked people are
in Settings -> General.

## Settings

The gear in the title bar opens:

- **General** — recent message history on join, the two link-preview switches, the list of
  blocked people, and the button that opens the log folder
- **Accounts** — the accounts you're signed in as, which one new tabs use, permissions, and the
  Client ID
- **Appearance** — chat font size, timestamps, 7TV badges, italic `/me` actions, whether your
  Twitch avatar shows beside the message box, whether tabs scroll on one row or wrap onto
  several, and which picture a new tab puts behind its name and how faint it is
- **Emotes** — which emote services to use, whether 7TV emote changes are announced, and the
  hidden-emote lists
- **Notifications** — which mentions ping, and which to ignore entirely

Settings that need explaining carry an info dot on the label; the ones that say what they do
don't.

Three things here reach something that isn't Twitch or an emote provider. Joining a channel asks
[recent-messages.robotty.de](https://recent-messages.robotty.de) for its recent history -- Twitch
offers none to apps like this one -- which tells them which channels you read; turning off *Show
recent message history on join* in General stops it. Opening a chatter's card asks
[ivr.fi](https://api.ivr.fi) for the follow and subscription lines, which tells them the name you
clicked and the channel you clicked it in; that one only happens when you open a card. The third
is the only one that isn't a service this app chose: a link preview loads from whatever host was
linked, so hovering tells that host you're here. That's why it waits before fetching, and why
it has a switch of its own.

## Updates

ChatWow updates itself. A moment after it starts it asks GitHub whether there's a newer
release, and if there is, a dot appears on the settings cog. It stays there until you do
something about it -- nothing pops up, and nothing is downloaded until you ask for it.

Settings -> General -> Updates has the version you're on and a button. Press it and the new
version is fetched and checked against a key built into the app, so a download that isn't
the real thing won't install. On Windows the app closes and comes back on its own once it's
done. On macOS and Linux the button turns into *Restart* when it's ready, and waits for you.

The first switch on that page turns off the check on launch. The button still works; nothing
else changes. It's the only thing this app asks github.com.

Two things to know. If you installed the `.deb` or `.rpm`, the app will still tell you a new
version is out, but the button is greyed out -- replacing those is your package manager's job,
not the app's. And a version older than 0.6.0 has none of this, so that one has to be
installed by hand.

## When something goes wrong

The app keeps a log of what it was doing -- channels joined, connections dropped and remade,
requests that failed, and anything that crashed, with a backtrace. Settings -> General ->
Diagnostics has a button that opens the folder it lives in; it holds the last few runs and
rotates itself, so it can't grow without bound.

It's safe to attach to a bug report: no message text and no account tokens ever go in it. If
you're chasing something specific, starting the app with `CHATWOW_LOG=debug` set turns the
detail up for that run.

## Shortcuts

- `Ctrl/Cmd+T` — join a channel (`Ctrl+K` does the same)
- `Ctrl/Cmd+W` — leave the channel you're reading, or close the mentions tab (in a split
  window, in the half you last clicked in)
- `Tab` — complete the word you're typing to an emote or a chatter; again to cycle, `Shift+Tab`
  to go back
- `@` + `Tab` — complete a chatter's name only, inserted as `@name, `
- `:` — open the emote and emoji search; `↑`/`↓` to move, `Tab`/`Enter` to take, `Esc` to close
- `/` — open the command picker, same keys
- `↑`/`↓` — step back and forward through your sent messages in this tab
- `Esc` — close a chatter's card, or cancel a reply

On macOS the window closes with its own button or `Cmd+Q`, since `Cmd+W` closes a tab here.

## Not supported yet

A dedicated whisper view (they land in the channel you're reading, in the account they were sent
to), and searching chat history.

## Working on it

It's a Tauri 2 and React app: Rust handles the connection to Twitch, the frontend only draws.
[ARCHITECTURE.md](ARCHITECTURE.md) covers how it fits together and why the awkward parts are the
way they are; [CLAUDE.md](CLAUDE.md) is the working brief for agents.
