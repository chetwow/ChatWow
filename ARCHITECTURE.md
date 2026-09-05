# Architecture

How ChatWow is put together, and why the awkward parts are the way they are.
[README.md](README.md) describes the app from a user's side. This file is the long form: what
talks to what, and which decisions have a reason behind them that isn't visible in the code.

## The Rust/React boundary

The IRC connection, asset fetching, and message resolution all live in Rust; React only renders.

```
Twitch IRC (wss)  ─┐
7TV v3 API        ─┼─→ Rust: parse → resolve → "chat://messages" ─→ React store → render
Helix badges API  ─┘
```

The backend emits **fully resolved** messages — badges already mapped to image URLs, message
text already split into text/emote/mention/link/GIF segments. Three things make this worth doing in
Rust rather than the webview:

- Twitch's `emotes` tag indexes by Unicode **code point**. Byte or UTF-16 indexing corrupts any
  message containing non-BMP characters (emoji, most notably).
- Twitch's `gifs` tag uses the same ranged-message model and carries the accessible caption, GIF
  id and complete asset URL together; parsing it beside emotes keeps the two ordered correctly.
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

Those rows are drawn at 60% opacity, which is the whole of how a replayed message is marked: no
label, no rule, because a backlog is dimmed all at once and it's the *boundary* that carries the
meaning -- the point where chat starts being now. `rise`'s keyframes deliberately leave opacity
out of the `to` frame so a row animates in towards its own value rather than flashing to 1 and
dropping back, which matters for the deleted rows too.

It answers with *raw IRC lines*, tagged `historical=1`, which is what makes it cheap here --
[`src-tauri/src/irc/history.rs`](src-tauri/src/irc/history.rs) hands them to the same parser,
emote resolution and renderer as the live socket, so a replayed message is indistinguishable from
one that just arrived except for the flag. That flag matters: a backlog isn't news, so it never
pings, reddens a tab or counts as unread, however recently it was said.

Two details it's easy to get wrong. The session remains unready until the backlog and every live
message buffered behind it have been queued in final order. That transition is protected by the
session write lock, so a new socket message cannot observe readiness and jump into the middle of
the backlog. And the history runs up to now while the buffer starts partway through it, so the two
overlap by however long the fetches took -- Twitch's message ids settle that exactly, preferring
the live copy so it is not treated as historical.

It's fetched per *session*, not per channel: a second account opening a channel the first is
already in is a fresh join with its own backlog, even though the room's emotes and badges are
already in hand ([Accounts and tabs](#accounts-and-tabs)).

Worth knowing: it's one volunteer's server, so a failure is a non-event (no backlog, not a broken
join), and asking it about a channel tells it you joined that channel -- the one thing this app
does that Twitch and 7TV don't see. Users can opt out of being recorded at
<https://www.twitch.tv/recent_messages>, and Settings -> General -> *Show recent message history
on join* turns it off here, after which the app only ever talks to Twitch and 7TV.

## Losing the connection, and coming back

A socket that drops takes chat with it, and a channel that has simply stopped moving looks
exactly like a quiet one. So the app says both halves out loud, as ordinary notices in every
channel the account was reading: `Disconnected from Twitch -- reconnecting` when the socket
goes, and `Reconnected` when it's back, naming how many messages were recovered.

The gap itself is filled from the same history service the join uses, which means the same
preference governs it -- with *Show recent message history on join* off, a reconnect is the line
alone. `announce_drop` ([client.rs](src-tauri/src/irc/client.rs)) writes the first line and marks
each of that account's sessions with `interrupted_at`, and `resume_channel` is what runs on the
ROOMSTATE that comes with the rejoin.

Three things about it are load-bearing.

**Where the gap starts is frozen at the drop, not read at the rejoin.** `Session::last_seen`
carries the `tmi-sent-ts` of the newest message that session has queued, written for every
message under the read guard the readiness check already takes -- an atomic precisely so it
needn't be a write lock on a per-message path. But live messages start arriving the instant the
socket is back, and reading the mark *then* would put it on the far side of the very gap it's
meant to open, so `announce_drop` snapshots it. A channel that has said nothing at all since the
join has no message to measure from, and falls back to the wall clock, which is the one place
our clock and Twitch's have to agree.

**A rejoin is not a join.** ROOMSTATE arrives on both, and a dropped session is also not ready,
so `interrupted_at` is checked *first*: running the full join would re-ask Twitch for emotes it
already has and replay a backlog that's already on screen. `load_channel_assets` also seeds
`last_seen` from the backlog it just placed, or a channel quiet since the join would have no mark
and recover its whole history as though none of it had been seen.

**The session is held un-ready while the history is fetched**, exactly as the join does it, so
what was missed lands *above* the live messages rather than after them and the whole gap reads in
order: the disconnect line, then what was said, then the reconnect line. The overlap between "up
to now" and "from the moment we were back" is settled by message id, the same way.

Recovered messages keep their `historical` flag, since they come from the same service tagged the
same way. They render normally, mention highlight included, but they don't ping, count as unread
or reach the mentions tab -- which is deliberate for a 150-message ceiling on what one reconnect
can deliver, and the one place this is a judgement call rather than a fact.

Connections and their asynchronous join/recovery loaders carry monotonically increasing
generations. A replacement socket owns fresh sessions, and a loader may commit only while both
its connection and load generation are still current. This prevents a closing socket from
removing the replacement's session and prevents two ROOMSTATE frames from racing duplicate
history loads into the same view.

Desktop Tauri does not expose a portable resume event, and an operating system can leave a TCP
socket looking open after the machine wakes even though its route disappeared during sleep.
`watch_for_system_sleep` samples wall time every fifteen seconds; a gap of at least forty-five
seconds means the runtime was suspended, so every IRC task receives its ordinary reconnect
command, whisper EventSub sockets are rebuilt, and the live-channel poll is refreshed. Wall time
is deliberate: monotonic timers do not include system sleep on every desktop platform. Reusing
the normal reconnect path also preserves the disconnect notices, session generations, and
missed-message recovery above.

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

The sender is the *tab's* account rather than "the" account -- which composer you typed into is
what decides who says it, and with a channel open twice that's the only thing that does. The
echo comes back on that account's own IRC connection, stamped with it, so it lands in the tab it
was sent from and not in the one beside it.

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

The message context menu exposes delete, ban and timeout commands when at least one open tab on
that message's channel has a moderator or broadcaster role. In a listener tab it prefers the
channel tab using the account that received that copy, then falls back to another moderator tab
on the same channel. The commands still go through `runCommand`, so the chosen tab's account and
granted scopes remain authoritative. `CLEARCHAT` events keep a session-only channel-and-login
record of active bans and timeouts; that is what changes moderation controls on a deleted row to
Unban. Timeout records carry their expiry, while a successful unban clears either kind locally.
The one-click duration is a persisted preference; the arbitrary-duration dialog accepts one
second through Twitch's two-week maximum.

`/me` is the exception: it's a message rather than a command and goes out through the send path
like any other text.

`/mods` and `/vips` only work in your own channel, unlike Twitch's own chat: Helix's Get
Moderators and Get VIPs both require the `broadcaster_id` to match the user in the tab's token, and
there's no public endpoint for anyone else's list. Twitch's web client reads it from an internal
API this app can't use.

## Whispers

Whispers arrive on their own socket: Twitch doesn't deliver them over IRC at all, so
[`src-tauri/src/twitch/eventsub.rs`](src-tauri/src/twitch/eventsub.rs) holds an EventSub
WebSocket subscribed to `user.whisper.message` (the *Your own account* permission covers it) and
feeds the same batching sink the chat connections use. A whisper is addressed to one account, so
there's one of these per account that can carry one, and the message is stamped with whose it is
on the way out. EventSub sends the sender and the text and
nothing else -- no emote ranges, no badges, no color -- so a whisper resolves 7TV globals, links
and mentions from its text, the name gets the usual palette color, and there are no badges to
draw. It carries no channel either, so Rust sends an empty one and the store files it under whichever
channel of *that account* you're reading -- only the frontend knows which that is -- as well as
into that account's mentions log.

The restart signal is owned by the supervisor rather than by each socket: one `Notify` wakes one
waiter, so several sockets can't share it. A subscription belongs to the token that made it, so a
token change drops every socket and brings back the ones still wanted. What must *not* happen is
restarting them when nothing changed -- re-validating a good token, at startup or at an hourly
check, rewrites its scopes and login, which is worth persisting but leaves the old subscription
behind on Twitch's side, and three of those is the limit for one type and condition. Past that
Twitch refuses and whispers stop arriving, silently. `restore_session` keeps `changed` and
`credentials_changed` apart for exactly this reason; it was a real bug.

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

They're separate in a second way now. What to *ask* for is one list for the whole app
(`permission_groups`), because it's a property of the next sign-in; what was *granted* rides on
each account (`Account::scopes`), because it's a property of a token. So an account signed in
before a box was ticked simply doesn't have it. The accounts panel makes the account being edited
explicit and shows that token's status beside each group; its reauthorization reminder is derived
from that selected account and disappears when the replacement token has the requested scopes.
The selectable new-account card exposes the same request controls before starting sign-in. Every
runtime scope check also takes an account -- two tabs on one channel can honestly offer different
commands.

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

The runtime override under Settings -> Accounts exists for the case the built-in one can't cover:
the shipped Twitch app being suspended or rate-limited, where the alternative would be waiting
for a new release. It's stored under its own settings key, so an override only ever exists
because someone deliberately set one in this build -- a file left behind by an earlier build
can't silently redirect the app. One Client ID covers every account -- it identifies the *app*,
not the user -- so changing it signs all of them out: Twitch issues a token against one specific
Client ID, and one held across a switch reads as a broken session rather than a signed-out one.
The tabs stay, anonymous, as they do whenever an account goes away.

No client secret is ever needed or stored. Tokens live in `settings.json` under the app's
per-user config directory, one entry per account. The directory and file are private to the
current user on Unix (`0700`/`0600`); Windows uses the user's AppData ACL. Writes replace the
file atomically, so an interrupted save cannot leave credentials in a partial JSON document.

They don't last, and the app outlives them. A Twitch user token is good for a few hours where a
chat client is left open for days, so `poll_tokens` walks every account once an hour and renews
anything with less than ninety minutes left on it -- a margin deliberately wider than the gap
between checks, or a token could die in between. `restore_session` makes the same pass at launch,
against the same margin and through the same `check_token`, so an app opened shortly before an
expiry doesn't start on a token that dies before the first check. Both read the remaining life
from `/oauth2/validate` rather than storing a deadline, which would be wrong on a machine whose
clock has drifted or that slept through the interval.

Nothing enforced this before, and the symptom was misleading: IRC authenticates once, at connect,
and Twitch leaves the connection alone afterwards, so chat kept arriving perfectly while every
Helix call -- sending a message included -- answered 401, with only a re-login to fix it.

A renewal deliberately touches nothing else. The live IRC socket stays authenticated, and
`connect_once` reads the current token whenever it next reconnects for its own reasons; the
whisper socket is left alone for the reason above. Only losing an account reconnects anything,
because its tabs have just become anonymous. And losing one takes a refusal, not a failure:
`auth::RefreshOutcome` separates Twitch rejecting a refresh -- the grant is gone, the account with
it -- from being unable to ask at all, which changes nothing and is retried at the next check.
Collapsing the two would sign everybody out the first time a laptop woke before its network did.

## Mentions

A message that names you -- `@yourname` or just `yourname`, case-insensitively and only as a
whole word, so `youtube` doesn't count -- gets the same rose highlight as a reply to you, and
plays a short two-tone ping ([src/lib/notify.ts](src/lib/notify.ts) synthesizes it with the Web
Audio API rather than shipping an audio file). Your own messages never match, so saying your own
name doesn't light up the line you just sent. One batch of messages pings at most once, and no
more often than every 1.5s.

Mentions are counted per tab alongside unread, and a tab holding any turns its unread badge
from accent to rose. The badge only changes color, never size -- see below.

Channel views also project every currently retained highlighted mention onto the scrollbar track,
unless `showMentionMarkers` is disabled. The rail uses the same per-tab
`isAboutYou` and ignore/block decisions as `MessageRow`, so it cannot disagree with the row's rose
highlight. Each marker maps the measured row position to the scroll position that would center it,
previews that message on hover or keyboard focus, and can make the jump when clicked. While the
native thumb passes over one, the marker fades and
stops accepting pointer input so dragging or clicking the scrollbar takes precedence.
Measurements rerun through a `ResizeObserver`: row heights vary, and `content-visibility` can
replace an off-screen estimate after layout. Listener tabs omit the rail because every visible
row is already a match; filling the track would add no location signal.

`isAboutYou` in [src/lib/mentions.ts](src/lib/mentions.ts) is the single answer to "is chat
talking to this login": named, or replied to, and never that login's own message. Ordinary
channel-row highlighting reads it directly. A custom mentions listener applies that same answer
to any of its selected accounts, or independently matches one of its phrases.

Which "me" is the tab's, not the app's: it takes the login of the account that tab reads as, so
the same message highlights in one tab and passes unremarked in the one beside it on the same
channel. That's also why it lives in the frontend rather than in `render.rs` -- it depends on
who's signed in, which changes without the already-resolved backlog being rebuilt.

## The mentions tab

A mentions tab is a named listener across selected open channels. The join dialog creates any
number of them from a collapsible form: a name, one or more channel logins, zero or more signed-in
account ids to detect mentions of, zero or more arbitrary chatter logins to follow, zero or more
phrases, and whether matches should notify. At least one account, followed user, or phrase is
required. Its persisted `Tab::mention` groups that definition together; channel tabs have
`mention: None`. Renaming changes that definition in place, preserving the listener's tab identity
and log; its right-click menu can also change the notification flag or open Options to replace the
full definition. Saving Options preserves the existing log and changes matching only for messages
received after the updated definition takes effect.

A message qualifies when its channel is selected **and** either it addresses any selected
account (through `isAboutYou`), was authored by a followed chatter login, or its visible
body/system text contains any phrase. Chatter-login matching is case-insensitive and includes
every message that user sends. Phrase matching is a case-insensitive substring and ignores
messages authored by any currently signed-in login; that exclusion applies only to the phrase
branch, so a message that genuinely addresses a different selected account still qualifies.
Selected accounts are identities to match, not the socket a message arrived on: if two selected
accounts both have the room open, the two IRC copies of one Twitch message collapse to one
listener row by message id.

Right-clicking a chatter's name offers a one-step listener for that login in the message's channel.
It uses the chatter's display name as the tab name, follows only that login and channel, and starts
with notifications disabled. As the one backfill exception, it immediately seeds the log with that
user's live messages still held by the current channel; Options can expand or change it afterwards.

The listener is deliberately not a connection owner. `AppState::wanted` derives sockets only
from channel tabs, so closing the last tab on a selected channel stops that listener's input from
the room; reopening the channel resumes it. Every close path first checks whether it would remove
a listener's last source and, while `warnOnListenerClose` is enabled, shows the warning dialog.
The dialog's "Do not show this warning in the future" choice persists through that preference,
which can also be restored in Notifications settings.

It remains an ordinary `Tab` with `kind: "mentions"` and an empty channel, sharing `active`,
`unread`, `mentions`, ordering, split placement and close behavior with channel tabs. The visible
label is the listener's name. Its only view-level differences are that `ChatView` renders
`mentionLog[tab.id]`, highlights every row as a match, draws a channel chip, and omits the
composer and Reply action because there is no single destination channel.

`ingest` appends only live, non-ignored matches to each listener's own log. A listener created from
the full form starts empty; the chatter-name shortcut alone seeds the selected user's live messages
already held by that channel. Later filter edits never backfill or remove rows: the active
definition applies only to messages received from then on. The stored row is the same immutable
message object as its channel copy; `clear` therefore rewrites every listener log as well as the
affected channel view. Replayed and recovered backlog never enters a listener or triggers its
unread count or notification. A custom listener's notification flag gates both the existing
mention sound and rose tab badge; collection and the ordinary unread count continue when it is off.

The global mention-kind toggles and both situational mute controls gate only the sound: message
highlighting, collection, unread counts and rose badges are computed independently. By default,
ordinary mentions visible in either active pane are silent, while whispers keep their existing
exception because they arrived from outside that room. The optional window-active mute is broader:
when `document.hasFocus()` says ChatWow is the focused app, it silences every ping, including a
whisper or a notification from a background tab. The title-bar mute remains the unconditional
sound override.

Tabs saved before custom listeners have `mention: None`. They retain the old behavior -- one
account's mentions, replies and whispers across its open channels -- while still obeying the new
rule that the mentions tab itself does not keep an account socket alive.

One exemption: the rose bar at a scrolled-off edge skips mentions tabs. That bar means "something
past this edge named you", and pointing at the tab where those matches are gathered adds no useful
information.

The user card takes its channel from the clicked *message* rather than the view, which keeps its
follow and subscription lines about the channel where the message was actually said.

## Ignoring and blocking

Two lists, in [src/lib/ignores.ts](src/lib/ignores.ts), both matched in the frontend for the
reason the emote blacklists are: adding a rule has to change what's already on screen, and those
messages were resolved before the rule existed and are immutable.

`mentionIgnores` is one mixed list because the two things in it are one instruction with
different scope -- `@login` is "don't tell me when this person names me", `#channel` is "don't
tell me about mentions in this room". The prefix is both the scope and what you type to add one;
a bare word is read as a person, which is the case worth defaulting to. A channel rule
deliberately doesn't silence whispers: a whisper's channel is only wherever you happened to be
reading when it arrived. Both lists are shared by every account, like every other preference --
someone you don't want to hear from isn't someone you want to hear from as your other login.

An ignored mention loses everything a mention has -- the ping, the count, the rose highlight, and
its place in the mentions tab. It stays an ordinary message in its channel, because the person
isn't being silenced, only the alarm.

`blockedUsers` is stronger and simpler, and holds bare logins: `MessageRow` returns null for
them, so nothing is drawn at all rather than a "message hidden" placeholder -- the point of
blocking someone is not to be reminded of them. Blocking implies ignoring, since a message that
isn't drawn shouldn't still be ringing a bell somewhere; `ingest` checks both together.

Neither list touches Twitch. Twitch's own block is an account-level thing that follows you to
every client, needs a scope this app doesn't ask for, and still delivers the blocked person's
messages over IRC -- so it would need this local half anyway to visibly do anything.

## Tabs

The tab bar computes its own row wrapping in JS, measuring each tab and reserving room for the
add-channel button, and re-runs that from a `ResizeObserver`. That makes a tab's rendered width
load-bearing: anything that changes it on hover (or when a channel finishes loading, or goes
live) re-triggers the observer mid-transition, corrupts the measurement, and flickers a tab
between rows. Hence the fixed-size slots -- the close button shares the unread badge's, the
status dot's is reserved whether or not a dot is in it.

A tab deliberately doesn't say which account it reads as *in words*. The row is scanned for
channel names, and a second word on every tab costs more room than it buys -- the question is
answered where it's asked instead: the right-click menu ticks the current account, and the
composer names the one it sends as in its placeholder and, when enabled, the account slot beside
it. `composer_avatar_mode` makes that slot the Twitch avatar, theme-colored generic initials, or
nothing; the generic mode uses the first two username characters, while Twitch mode falls back
to the account's first initial. Both use a silhouette for Anonymous, where no name exists. The
slot is the half that survives typing -- with the same channel open under two
accounts the tabs look alike, and the placeholder is gone by the second character.

A picture is the exception, because it costs no words and no width: a tab can draw one behind
its name, faintly (`tab_avatar_opacity`, 40% by default -- a setting because how visible a
given opacity looks depends entirely on the avatar behind it) and absolutely positioned, centred
on the text. Out of flow is the
whole trick -- `offsetWidth` is what the row-wrap measurement reads, so a picture in the layout
would move the breaks, and one that arrived late would move them again.

Which picture is the tab's own property (`Tab::avatar_mode`), not a preference read at render
time: `none`, `owner` (the channel's) or `account` (the one it reads as), changed from the tab's
right-click menu. The preference (`new_tab_avatar_mode`) is a rule for *new* tabs only, and
`stamped_avatar_mode` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) applies it once, as the tab
is opened -- so changing the setting never rearranges what's already open, and a tab you've
pointed at something stays pointed there. It carries a fourth value the tabs can't, `otherAccount`:
your picture unless the new tab is on your default account, which is a question with a plain
answer at the moment a tab is made and none at all afterwards, once the tab's account can change
under it. Tabs restored from a build without the field are stamped the same way on the way in,
so nothing downstream distinguishes "chose this" from "never chose".

Owner avatars are fetched by the live poll ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) rather
than on join, because they want exactly what it already has -- a token, the open channels, and a
wake-up on both a join and a sign-in -- while asking for far less: Get Users answers about a
hundred logins in one call, and a login is asked about once and kept, a streamer's picture not
being something that changes while a chat client is open. Signed out there's no token, so
nothing is asked and the tabs draw nothing, the same degradation as the live dots and badge art.
They're keyed by channel like the emote sets, since the face belongs to the room.

Right-clicking a tab (or the composer, which is the same tab speaking) opens
[AccountMenu.tsx](src/components/AccountMenu.tsx): every account, Anonymous, and Close tab.
Clicking either visible composer avatar opens the same menu, and is the direct way in when the tab
is anonymous -- a disabled input takes no mouse events at all, so the right-click never reaches
it. With the avatar set to none, the tab's right-click menu remains the account control.
Context menus stay open when chat scrolls underneath them. They still close on selection, outside
click, Escape, window blur, or when the caller replaces them with another menu.

The single-row mode ([src/components/TabBar.tsx](src/components/TabBar.tsx), behind the
`singleRowTabs` preference, and the default) skips that measurement entirely and clears any
breaks left from wrap mode, and its observer is rebuilt on the toggle -- switching back mounts a
row element the original observer never saw. Its scrollbar (`.quiet-scroller`, shared with the
settings dialog's own tab row) is styled through `::-webkit-scrollbar` alone: the
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

Keyboard tab selection follows the same single `tabs` order that persistence and the pane
boundary use. The platform primary modifier plus 1–8 selects that numbered tab, while 9 selects
the final one; Ctrl+Tab/Ctrl+Shift+Tab on Windows and Linux or Cmd+Option+Left/Right on macOS
cycles with wraparound. `setActive` derives the selected tab's pane and focuses it, so a shortcut
crossing the split boundary also makes that pane the owner of subsequent focused-pane actions.
These shortcuts pause while a modal is open, where the dialog remains the active context.
macOS also maps `Cmd+,` to the General settings screen in the webview; there is no Windows
binding because that platform has no universal Settings shortcut.

The most recently closed tab is retained in frontend memory with its former pane position.
`Ctrl+Shift+T` on Windows/Linux, `Cmd+Shift+T` on macOS, or **Reopen closed tab** in a tab-bar
context menu adds it through the ordinary validated backend path and moves it back into that
pane. This is deliberately one session-only undo record, not another persisted tab list. Closing
a first-pane tab moves `splitIndex` with it so the other pane's first tab is not silently pulled
across the boundary. If the closed tab's account has since been removed, a channel or legacy
listener reopens Anonymous; custom listeners drop removed account IDs, and an account-only
listener left with no valid account or other matching criterion is no longer reopenable. The
backend's reopen flag exists solely to admit old `mention: None` listener tabs that ordinary new
tab creation correctly refuses.

`Ctrl/Cmd+W` closing a tab is why the macOS menu bar is built by hand
([`macos_menu`](src-tauri/src/lib.rs)): Tauri's default menu binds `Cmd+W` to Close Window, and
a menu key equivalent is matched before the keystroke ever reaches the webview.

## Accounts and tabs

Several Twitch accounts can be signed in at once, and **a channel tab picks one**. That single
sentence is what re-keys the app: the same channel can be open twice under two logins, so a
channel name no longer identifies a view. A `settings::Tab` -- `{ id, kind, channel, account,
mention }` -- does, and everything kept per view (messages, unread, scroll position, sent
history, completable emotes, role) is keyed by its id. `channel` still keys what belongs to the
*room*: emote sets, badge sets, room id, who's live. A mentions tab instead owns a `mention`
filter and uses `account` only as a legacy/compatibility field.

`Settings::tabs` is the whole list, in bar order, and it's what the connections are derived
from. `AppState::wanted` reduces it to "which account needs to be in which channels", and
`client::sync` makes that true: it spawns a socket per account, sends the joins and parts that
differ, drops sockets nothing wants any more, and forgets the sessions and channel data that
went with them. Every tab change ends there, so nothing else has to reason about connections.

One socket per account rather than one for the app, because **IRC authenticates per
connection** -- the login *is* the connection, and there is no way to read as two accounts on
one. Whispers are the same story for
the same reason: `user.whisper.message` is a subscription made with one token, so there's an
EventSub socket per account too. Every message the backend renders is stamped with the account
whose socket received it (`ChatMessage::account`), and that stamp is what routes it to a tab:
with a channel open twice, the two copies are otherwise identical.

What was one question is now two:

- **A channel's assets are fetched once; a session's are per account.** The emote and badge sets
  belong to the room. The backlog, the messages buffered while joining, the Twitch emotes this
  login owns (subscriber emotes) and the `USERSTATE` role belong to `state::Session`, keyed by
  (account, channel) -- a second account joining a room the first is already in still needs all
  of them.
- **"Is this about me?" is per tab.** `isAboutYou` takes the login the tab reads as, so the same
  message highlights in one tab and not in the one beside it. Custom mention logs are per
  listener tab, because each independently selects accounts, channels and phrases.

Calls that ask Twitch about the *world* rather than about you -- badge images, who's live,
channel search, a link preview -- go through `Auth::any_credentials` instead: any token answers
them identically, so needing a particular one would mean losing them the moment a tab went
anonymous. Sending, slash commands and emote completion use `Auth::credentials(account)`, since
those are about you and about which of you.

Anonymous (`settings::ANONYMOUS`, the empty id) is a first-class account rather than a failure.
It's how the app works before you ever sign in, it stays a per-tab choice afterwards, and it's
where a tab lands when its account is signed out -- the tab keeps reading and loses its composer,
which beats losing the channels you had open.

Scopes are granted per token, at sign-in, and can't be escalated afterwards
([Permissions and scopes](#permissions-and-scopes)) -- so `permission_groups` (what the next
sign-in asks for) is shared, while `Account::scopes` (what this one got) is not. The command
picker asks per tab, and two tabs on the same channel can genuinely offer different commands.

An older `settings.json` is migrated on load (`settings::migrate`): one account's tokens become
the first entry in `accounts`, the channel list becomes a tab each, and the mentions tab -- three
preferences before this -- becomes a tab where those three described. The keys it reads are
`skip_serializing`, so they survive exactly long enough to be migrated and leave the file on the
next save.

## Split view

The window holds one pane or two, never a tree of them: `splitLayout` is `none`, `row` or
`column`, and `splitRatio` is the first pane's share of that axis. Both live in `Preferences`
with everything else the user can set, so a split window comes back split.

Which pane a tab is in is **one number**, `splitIndex`: how many of the leading `tabs` belong to
the first pane. `tabs` stays the single record of what's open and in what order -- it's the
backend's list, written by `reorder_tabs` -- so dragging a tab across the divider is an ordinary
move within it, and no tab can end up in both panes or in neither. A second list per pane would
have to be reconciled against that one on every open, close and reorder; a boundary can't drift
out of agreement with itself.

`paneTabs` and `paneOf` ([src/store/chat.ts](src/store/chat.ts)) derive everything from those
pieces, and `commitTabs` writes a rearranged pair of tab lists back to them -- order to the
backend, boundary to the preferences, each only if it actually changed. Every rearrangement (a
drag across, a close, an unsplit) then runs `settleActive`, which corrects each pane's open tab
against the tabs it actually holds rather than patching `active` by hand at each call site.

`active` is therefore a pair, one tab per pane, and both are "what you're reading": a message
that lands in either is one you can see, so neither counts as unread. `focusedPane` -- the pane
you last clicked in, tracked by a capture-phase pointer handler on the pane wrapper -- is the
narrower question of where a whisper is filed, what `Ctrl/Cmd+W` closes, and which half a newly
opened tab drops into. A tab opened from the first pane arrives at the end of `tabs`, which is
the *second* pane, so `placeNewTab` moves it back across.

Two panes mean two composers, and a composer reclaims focus on any keystroke anywhere in the
window, so chat feels always-focused. Exactly one of them can be doing that,
or they take turns stealing the caret from each other -- hence `capturesTyping`, which is the
focused pane, or the other one when the focused pane has nothing open. It gates the mount-time
focus as well: a composer mounting in the half you *aren't* working in (its pane fell back to
another tab when you dragged one out) would otherwise take the caret and, through the focus
handler, the pane focus with it.

Dragging a tab between panes is HTML5 drag and drop, and the payload can't be read until the
drop -- so the tab being dragged lives in a small store of its own
([src/store/tabDrag.ts](src/store/tabDrag.ts)) that both bars and both panes can see. A pane
accepts a drop anywhere in its body, not just on its tab bar: an empty one has no tab to aim at.

The split menu hangs off a title-bar button. Like message, tab, and account menus, it remains open
while chat moves; incoming messages and manual scrolling are not dismissal actions.

## Message history

`↑` in the composer walks back through what you've sent in the current channel, `↓` comes
forward again; stepping past the newest entry restores whatever you'd half-typed when the walk
started, and typing over a recalled message ends the walk so the next `↑` starts from the top.
History is per channel and lives only for the session, and a repeat of the previous message
doesn't add a second entry. The emote picker takes the arrows first while it's open.

## Searching a tab

The find session targets the active tab in the focused pane, which is the same ownership rule as
the other title-bar actions. `Ctrl/Cmd+F` opens or refocuses the search row inside that tab, while
the title-bar magnifier toggles it; moving focus to another active tab closes it. The query stays
in `ChatView` and searches
the already-resolved, immutable message objects in memory -- sender, channel, reply, system, and
body text -- so finding never crosses IPC or starts an external request. Blocked rows are excluded
because there is nothing visible to navigate to. Enter and Shift+Enter move through matches, and
leaving the live edge disables scroll pinning so incoming chat cannot pull the selected result
away. Closing search jumps back to the live edge and restores pinning.

## Twitch GIF messages

Twitch GIF messages stay on the ordinary IRC `PRIVMSG` path. [render.rs](src-tauri/src/render.rs)
reads the `gifs` tag, slices its inclusive ranges by Unicode code point, and sends React a GIF
segment containing the caption, id, and exact URL Twitch supplied. The renderer accepts only
HTTPS GIPHY hosts: live tags are Twitch-owned, but recent-message history is raw IRC supplied by
a third party and must not gain a way to point the webview at arbitrary or local hosts.

React streams the supplied GIF URL directly with native lazy loading and asynchronous decoding,
leaving reuse to the webview's HTTP cache rather than adding GIFs to the emote disk cache. This
also preserves the URL exactly as Twitch requires. `showGifs` is render-time state so changing it
repaints immutable messages already held in a memoized row. When it is off, no inline image is
created: the accessible caption uses the same dotted underline as a blacklisted emote, and its
shared hover preview is the only thing that loads the GIF. `gifScale` drives one root CSS custom
property used by both inline GIFs and their hover previews.

## Emote providers

Three services, plus Twitch's own emotes: 7TV
([src-tauri/src/emotes/seventv.rs](src-tauri/src/emotes/seventv.rs)), BetterTTV
([bttv.rs](src-tauri/src/emotes/bttv.rs)) and FrankerFaceZ
([ffz.rs](src-tauri/src/emotes/ffz.rs)). Each is asked for its global set once at startup and for
a channel's set on join, by Twitch user id; the three run concurrently. Successful answers are
persisted in `emote-catalogs.json` under the cache directory, separately per provider. The last
global snapshot is installed before restored sockets open, and a complete channel snapshot is
installed as soon as `ROOMSTATE` supplies its Twitch user id. Both are stale-while-revalidate:
the provider requests still run, their fresh answers replace the snapshot, and a failed or slow
provider keeps its last good answer instead of making its emotes disappear. Successful empty
sets remain distinct from failures -- a channel with no BTTV account 404s, which is the common
case and is cached as no emotes. Channel snapshots are bounded to the 128 most recently refreshed
rooms.

Room assets belong to the channel, not the account. A per-channel async lock makes simultaneous
`ROOMSTATE` messages from two account sockets share one provider/badge load. When a cached catalog
starts the room, its HTTP refresh runs in the background while the ordinary badge request
continues. Whole-map replacements carry a revision: a 7TV WebSocket update that lands during
that refresh increments it, preventing the older HTTP response from overwriting the live event.

`emotes::merge` folds them into one name→`Emote` map, lowest priority first: FFZ, BTTV, 7TV. So
where two providers ship the same name, 7TV's is the one that renders -- it's the set channels
actually curate. Channel emotes land in `ChannelData::emotes` and are looked up before the
globals, so a channel's own version of a name always wins.

Only 7TV marks zero-width overlays. BTTV and FFZ both have a notion of "modifier" emotes, but
theirs is a prefix syntax (`w!`, `z!`) applied to the emote *after* them rather than something
that stacks on the one before, so nothing here folds them.

Each provider can be switched off, and that takes two mechanisms for one reason. Rust stops
asking the service, which is what removes its emotes from the maps and from completion -- but the
messages already on screen were resolved before the switch and are immutable, so
[src/lib/emoteProviders.ts](src/lib/emoteProviders.ts) is consulted by `EmoteView` on every render
and draws the plain word instead. Turning one back on has nothing to draw until the sets are
fetched again, so `set_preferences` respawns `client::reload_emotes` whenever the enabled set
changes; it re-fetches the globals and every joined channel, then emits `chat://assets`, which the
frontend already treats as "rebuild every channel's completion index".

## 7TV emote sets changing under you

A channel's sets are fetched once, on join, so an emote the streamer added an hour into the
stream wouldn't exist for this app until the tab was closed and opened again. 7TV pushes those
changes over a WebSocket, and
[seventv_events.rs](src-tauri/src/emotes/seventv_events.rs) folds them back into `ChannelData`
and says so in chat.

One socket for the whole app, which is the difference from Twitch's EventSub
([Whispers](#whispers)): these events are anonymous and belong to the *room*, so there's nothing
to sign in as and a subscription names an emote set rather than a channel or a login. That set id
comes back from the same `/v3/users/twitch/<id>` call the emotes do -- `seventv::ChannelSet`
carries both -- and lands in `ChannelData::seventv_set`. `AppState::seventv_events` is a `Notify`
that every change to the open channels pokes: joining one, parting one, or switching 7TV off in
the settings, which re-fetches without it and leaves no set behind. The socket re-reads
`AppState::seventv_sets` and subscribes or unsubscribes to match; with nothing left to watch it
lets the connection go rather than hold an idle one, and `run` waits on the same signal until
there is.

A dispatch carries three lists -- `pushed`, `pulled` and `updated`, added, removed and re-aliased
-- and 7TV batches them, so a streamer emptying a set sends one frame, not fifty. `pushed`
carries the whole set entry, the identical shape `seventv::fetch_channel` reads, so an added
emote is renderable without going back to the API for it.

Removing one is the awkward direction. `ChannelData::emotes` is the three providers merged with
7TV on top, and dropping a name from that merge would take an FFZ or BTTV emote with it if 7TV's
had been shadowing one. So `ChannelData::other_emotes` keeps the FFZ+BTTV half on its own,
purely so a removal can put back what was underneath. Every removal is also guarded on the
emote's id: a name we're holding for some other provider, or for a different 7TV emote aliased
over the top, isn't the one being removed.

The announcement is an ordinary notice (`render::notice`), stamped once per account with a tab
on that channel -- a message reaches a tab by the account it names, and this is news for every
tab showing the room, whoever is reading it. Set changes are always announced, and the emotes
always follow the set because what a chatter can type has changed. The other half is
`chat://emote-set`, which carries the channel and its new emote count so the frontend rebuilds
that channel's completion index -- the same job `chat://channel-ready` does on join.

## 7TV badges

A chatter's equipped 7TV badge is resolved per user, because there's no longer any other way:
the v3 cosmetics route that once served every badge and its owners in one response is gone (it
404s), and v4 answers per user through GraphQL. One request per chatter would be absurd in a busy
channel, so [seventv_badges.rs](src-tauri/src/emotes/seventv_badges.rs) aliases up to forty
lookups into a single query -- `u0:userByConnection(...)`, `u1:...` -- and maps the answers back
by position.

Ids reach that query as string literals in a hand-built GraphQL document, so `is_user_id` drops
anything that isn't a plain number. Twitch user ids are numeric; nothing else in the query comes
from outside.

Every incoming message offers its sender to `AppState::queue_badge_lookup`, which is a set lookup
for all but the first message from that person -- "no badge" is an answer, remembered like any
other. New ids go down a channel to a task that lets them pile up for 400ms (a join alone hands
over a hundred chatters, between the backlog and the live messages) and then asks in one go.

Positive and negative answers are also persisted in `badge-catalogs.json`, bounded to the 20,000
most recently refreshed users. They are fresh for 24 hours. A fresh answer avoids the request; a
stale positive is drawn immediately and then refreshed, so removing or changing an equipped badge
eventually replaces it instead of making the disk snapshot authoritative forever.

The results are pushed to the frontend as `chat://seventv-badges` and kept in the store, *not*
folded into the messages: a badge lands after the message that prompted the lookup, and stored
messages are immutable, so a row that already rendered would never get one. `MessageRow`
subscribes to its own chatter's entry instead, which also makes the Appearance toggle apply to
the backlog immediately. Switching it back on clears the "already asked" set, so people are
resolved from the persistent cache or provider again as they talk.

## User cards

Clicking a name opens [UserCard.tsx](src/components/UserCard.tsx). Its top half is fetched, its
bottom half is free -- the messages that chatter has already sent in this tab, filtered out of
the store. That log is one tab only: the same name in two tabs is two conversations. The ear
action in its header creates the same current-channel user listener as the chatter-name context
menu, including its one-time backfill and notifications-off default.

The fetched half needs two services, because Twitch only answers one of it.

*Who they are* -- avatar and account age -- is Helix `GET /users`, which needs a token but no
scope. Any account's token answers it identically, so this goes through `any_credentials` rather
than the tab's own account: a card opened in an anonymous tab still shows an avatar as long as
something is signed in. With nothing signed in there is no token at all (a public client with no
secret can't mint an app token either), so the same two fields come from ivr.fi instead; the same
fallback catches an expired token, since something else can answer the question.

*Follow age and cumulative sub months* aren't in Helix at all. `Get Users Follows` was removed in
2023, and both replacements are scoped to you: `/channels/followed` needs the user id in the token
to match the one you're asking about, and `/channels/followers?user_id=` needs
`moderator:read:followers` and for you to be broadcaster or moderator there. Nothing public
answers "how long has X followed Y", and nothing at all answers someone else's cumulative months.
So that half comes from [api.ivr.fi](https://api.ivr.fi) -- the same third party Chatterino's user
card uses, and by the shape of its responses a proxy in front of Twitch's own private GraphQL API.

(A PRIVMSG's `badge-info` tag does carry sub months for free, but only for someone currently
subscribed who has already spoken in this channel -- too narrow to build the row on.)

Because ivr.fi is one person's service with no SLA, it lands in its own `history` field
([usercard.rs](src-tauri/src/usercard.rs)) rather than alongside the rest. `None` there is not
"doesn't follow, never subscribed" -- the card says *Unavailable*, and the avatar and account age
survive it. Only when *both* halves fail is there no card and an error instead. Logins are
pasted into a URL path, so `is_login` rejects anything that isn't `[A-Za-z0-9_]{1,25}` -- the same
shape of guard as the ids in the 7TV badge query.

The subscription line distinguishes four states, and `cumulative` is why: it outlives the
subscription, so months alone would claim a subscriber who left years ago. `meta` being non-null
is what says the sub is still running; `statusHidden` is someone who has hidden it, which is a
third thing again.

Answers are cached per channel-and-name for the session in
[lib/userCard.ts](src/lib/userCard.ts) -- none of it changes minute to minute -- and the card is
keyed on the login it's about, so clicking a second name remounts rather than reusing the first
person's state.

The card sizes itself from the window in both directions: a share of the width between bounds, and
a share of the height for the message log. The window's own minimum is 420x320, narrower than the
card's floor and shorter than its natural height, so the width clamps to what's available and the
log is the section that gives -- it has a scrollbar already, so shrinking it loses nothing. Its
position is measured after layout and clamped into the window: the name it hangs off is a row
inside a scroller and can sit partly, or entirely, outside the visible area.

## Link previews

Hovering a link shows what's behind it. The two halves are split by what the answer costs.

**An image link is classified locally and fetched by Rust.** `imagePreviewUrl`
([src/lib/links.ts](src/lib/links.ts)) tests the extension on the url's own path, then
`link_preview_image` applies the same network checks and size limits as page previews. The
frontend turns the bounded response into a local blob URL; the webview never requests a
chatter-selected image host directly. An extensionless image is deliberately classified as a
page rather than guessed from its eventual content type.

**Everything else has to be asked**, and that's [src-tauri/src/linkinfo.rs](src-tauri/src/linkinfo.rs):
one GET, and the page's own account of itself out of the head -- OpenGraph first, then Twitter's
copy of it, then the plain `<title>`. Those tags exist for exactly this, which is why the preview
is a scan for `<meta>` and not an HTML parse: two fields don't justify a parser, and titles and
meta tags are the two things a scan can find without meeting anything that would fool it.

It's the only fetch in the app whose address a stranger chose, so it doesn't share
`AppState::http`. Each hop resolves its hostname, rejects the entire answer if any address is
private, loopback, link-local or otherwise non-public, and pins the request to the addresses that
passed. Redirects repeat that process and proxies are disabled, closing both private-network and
DNS-rebinding paths. Requests have an eight-second timeout; page bodies are read in chunks and
stopped the moment they hold what's wanted, with 256KB as the ordinary ceiling. Preview images
use the same path and an 8MB limit. Page thumbnail URLs are resolved relative to the final page
URL and fetched through this gate too.

YouTube is the one site with a card's worth of things to say, and the one that makes you work for
it. A video's head sits behind ~700KB of inline script and the counts behind a little more, so
`youtube_id` recognizes a video url up front and that fetch alone gets a 1MB budget, stopping as
soon as the last wanted field has turned up. This is why `reqwest` has `gzip`/`brotli` on: that
page is about a fifth of its size on the wire, which is what makes reading so far defensible.
The duration comes from schema.org microdata in the head, the channel and counts from the
player's own JSON below it, read by looking for the field rather than parsing a megabyte of
script. A field that isn't there is a row that isn't drawn -- an unlisted video has no view count
worth showing, a channel that hides likes hides them here too.

Twitch's own links skip the page entirely. twitch.tv is a React shell whose OpenGraph tags are a
name and a generic blurb, and this app is already holding a token, so
[src-tauri/src/twitch/links.rs](src-tauri/src/twitch/links.rs) recognizes the three shapes people
paste -- a clip, a VOD, a channel -- and asks Helix. A clip costs two calls (the clip carries the
game's id, never its name); a live channel two, run together (the stream and the user are
independent); an offline one three, since what they last played comes from `channels`. Everything
about that path is best-effort: signed out there's no token and no app token to fall back on, and
a miss or a failure falls through to the ordinary page preview rather than becoming an error.

Rust hands over rows that are already formatted (`4:46`, `1.2M`, `3 Mar 2023`), the same split as
everywhere else: `render.rs` sends image urls, not emote ids, and the frontend does no arithmetic.

A preview carries its own `ttlSeconds`, which is how the cache knows what rots. Zero -- a page
title, a clip, a VOD -- means keep it for the session. A live channel says 120, because a viewer
count and an uptime are wrong within minutes and the alternative is a cache that either re-fetches
YouTube's megabyte on a schedule or shows a two-hour-old audience as current.

All of it shares one popup ([src/components/HoverPreview.tsx](src/components/HoverPreview.tsx))
with the emote preview, through one store -- two would leave both on screen at once, overlapping.
It positions itself from a measurement rather than a CSS transform: an emote is small enough to
centre on its anchor and be done with, but a link's card is a third of the window across, and
centred on a link near the edge (or hung above one in the top row) it would sit outside it. The
measurement re-runs when a picture lands, since an `<img>` with nothing decoded yet is a box of
empty space and the frame would otherwise be placed at a size it's about to outgrow.

Four things about the timing are deliberate. The preview waits ~220ms before anything is fetched,
because a request goes out to a host a stranger picked and a pointer crossing a message on its
way elsewhere shouldn't announce the reader to it. After that the spinner goes up *before* the
request, so the wait reads as a wait rather than as nothing happening. Once visible, a link
preview stays anchored where it opened until real pointer movement or Escape dismisses it:
incoming chat can move the link out from under a stationary pointer and generate `mouseleave`,
but it does not generate `pointermove`. While held, the shared store also rejects ordinary hover
previews synthesized by elements sliding under that pointer. Pointer movement over the original
link or the preview itself refreshes the held position rather than dismissing anything. A narrow
movement corridor bridges the visual gap between them; after leaving both, an eight-pixel radius
absorbs hand jitter before movement closes the card. Dismissal advances the shared preview
generation so an in-flight fetch cannot revive the card afterward. Answers are cached for the
session either way
([src/lib/linkPreviews.ts](src/lib/linkPreviews.ts))
-- "this link has no preview" is an answer, and hovering the same link twice shouldn't ask twice
-- with a cap, since chat is endless where the user cards are a handful of names you clicked. A
cached link draws with no spinner at all, since there's nothing to wait for.

`previewImages` and `previewPages` are two preferences rather than one because they promise
different things: a picture, or somebody's web page fetched and read. Which resolver serves them
isn't the split -- YouTube's megabyte and Twitch's Helix call both sit behind *pages*, since both
are a link to a page answered as well as it can be.

Which switch applies is decided by the *link*, before anything is asked, so `linkKind`
([src/lib/links.ts](src/lib/links.ts)) classifies by the url alone. An image is settled by the
extension on its path. A 7TV emote link is the other one under *images*: it isn't an image url,
but it previews as a picture, resolved by [src-tauri/src/emotes/seventv_links.rs](src-tauri/src/emotes/seventv_links.rs)
from `GET /v3/emotes/<id>` -- the same reasoning as `twitch::links`, since 7tv.app is a script
shell and the emote is a thing this app already knows how to draw. Rust answers it as a
`LinkPreview` carrying the name, the 4x image and the owner in `description`, and the frontend
draws it through the *emote* card rather than the page card: a 128px emote in a page card's
`object-cover` thumbnail would be a crop of a face.

Both preferences gate the frontend: the backend safely handles any public URL it is handed, but
the switch must prevent the IPC call if the user has disabled that class of preview. Nothing else
reads them, and a message already on screen picks up the change because `LinkView` subscribes to
the store instead of taking a prop -- the same reason the emote blacklists do.

## Emote completion and search

Both entry points -- `Tab` and the `:` picker -- are fed by the same index, built per *tab*: the
7TV global and channel sets, which belong to the room, plus Twitch's global and channel emotes
for that tab's account, which don't. Subscriber emotes are the reason for the split -- what one
of your logins can send isn't what another can -- so the same channel open twice offers two
different completion lists, and changing a tab's account rebuilds its own.

The `:` picker ranks an exact prefix above a coincidental substring hit, so a name that merely
contains what you typed is reachable without burying the one that starts with it. Emoji join the
results once letters are typed and rank below every emote, including emoji that do start with
what you typed. Tab completion stays prefix-only: it has no list to look at, so a surprise
substring match would be hard to predict.

Typing an `@` token opens a username picker above the composer; arrows choose a row, Tab or Enter
inserts it, and Escape dismisses that token's picker. The older Tab-only path cycles the same
matches. Chatter names are matched against both login and display name, ordered alphabetically,
and inserted into chat with the display name's own casing. The listener editor reuses that picker
without requiring `@`, merging the chatter inventories of its selected source channels and storing
the picked login rather than the display label.

The candidate lists are built from incoming messages and last only for the session: Twitch gives
a plain chat client no roster to read, and a stale name is worse than a missing one when you're
replying to someone. You're never in your own channel tab's list.

Both order their *emote* matches by how often you've sent each one, falling back to alphabetical
(chatter names are only ever alphabetical -- there are no counts to rank them by). Counts are per
emote name across every channel, kept in `settings.json` by Rust while the frontend applies the
ordering at match time, which is what keeps Tab and the picker synchronous -- neither waits on
IPC mid-keystroke. Every emote in a sent message counts, not just the completed ones. The counts
are shared across accounts as well as channels: what you reach for is what you reach for,
whoever you're typing as.

Twitch's own emotes are fetched from Helix purely to populate this index. They're deliberately
kept out of the maps that render incoming messages: an incoming message's `emotes` tag already
identifies its Twitch emotes by id, and matching on name instead would render any word that
happens to match an emote name as that emote, even from someone who doesn't own it.

Emoji come from a generated list of ~1,900 Unicode names
(`scripts/generate-emoji.py` → `src/lib/emoji.json`), dynamically imported so it stays out of the
initial bundle. Picking one inserts the literal character — Twitch doesn't expand `:shortcode:`.

## Chat images on disk

Emote and badge images are cached under the app's cache directory and served to the webview over
an `emote://` scheme handled in Rust, so a busy channel stops re-fetching the same inline art.
Files are keyed by **provider id, not name** — 7TV emotes are aliased per channel, so a name is
neither stable nor unique. Badge keys also fingerprint the provider URL so revised art for the
same badge id gets a new file. The cache fills lazily (an image is stored the first time it's
actually displayed), and a miss or failure falls back to the CDN url. Concurrent misses for the
same key share one download and its result.

Badge URLs cannot be reconstructed from their ids, unlike emotes, so `badge-catalogs.json` keeps
Twitch's global and 128 most recently refreshed channel definition sets beside the expiring 7TV
answers. Twitch definitions are installed only when credentials exist and refreshed through
Helix; signing out still clears the visible maps and produces text chips. The custom protocol
accepts a badge URL only when that stored metadata names Twitch's or 7TV's HTTPS image host, so a
webview-supplied cache key cannot turn the backend into an arbitrary URL fetcher.

The image directory is a 300 MB recency cache. Serving a file touches its modification time;
once the directory is over budget, the oldest images outside the current global/open-channel
working set go first, followed by the oldest active images only if the working set alone exceeds
the hard ceiling. Maintenance waits until every open channel's sets have loaded before giving
the active set priority; if a new download crosses the hard limit earlier during startup, it
falls back to pure recency rather than favoring a partial set. This keeps recently visited
channels warm instead of deleting their images as soon as their tabs close. Atomic-write
leftovers from an interrupted download are discarded during the same scan.

FFZ is the exception: its images aren't served from the cache at all. A key is
`<provider>-<id>` and nothing more, but FFZ puts animated emotes on a different path from static
ones (`/emote/<id>/animated/2.webp`), so the key can't say which url to fetch -- and asking for
the animated one speculatively doesn't 404, it hangs. `is_valid_key` omits `ffz` and
`CACHED_PROVIDERS` in [src/components/EmoteImage.tsx](src/components/EmoteImage.tsx) mirrors that,
so FFZ emotes load from the url the API handed us, which is already the right one for either
kind. BTTV needs no such care: it serves png, gif and webp from the same path.

## Settings

Preferences live in `settings.json` next to the accounts and the tab list -- `Preferences` in
[src-tauri/src/settings.rs](src-tauri/src/settings.rs), mirrored by the `Preferences` type in
[src/types.ts](src/types.ts), read at startup and written whole on every change. Saves are
serialized, written to a private temporary file in the same directory, synced, then atomically
renamed over the old snapshot. Missing files mean first run; malformed or unreadable files are
logged before defaults are used, and a malformed file is moved to a timestamped
`settings.invalid-*.json` rather than overwritten. Rust deliberately doesn't validate preference
values: the store normalizes an unknown one back to the default, so a hand-edited file can't wedge
the UI. Themes are a frontend-owned catalog of semantic color-token sets, applied to the app root
so changing one repaints the complete window without rewriting individual components. The current
palette is the default `Twitch` theme. Every built-in chat surface stays below the conservative
background luminance used by Rust's username-color contrast lift, so immutable messages remain
readable as themes change without making message resolution depend on frontend state. The
font-size preset resolves to a `--chat-font-size` custom property set on the app root;
only message bodies and the composer follow it, so nothing that measures its own layout moves
when it changes. GIF size similarly resolves to an independently clamped `--gif-scale` property.
Mock mode has no backend to write to and falls back to `localStorage`. The default moderator
timeout is stored as seconds and normalized in the frontend to Twitch's one-second through
two-week range.

The dialog is sized for the window's 420px minimum: the panel is `min(560px, 100%)`, setting rows
wrap their control under the label when they have to, and the tab row scrolls sideways rather
than wrapping to a second row that would push content off the bottom. Its height is fixed to the
window rather than the content, so switching tabs doesn't resize it. It also starts below the
title bar rather than at the top of the window: on macOS the traffic lights are drawn by the
system over everything the webview renders, so a dialog reaching the top of the window would
have them sitting in its corner.

Almost nothing carries an info dot. The reader is someone who went looking for a third-party
Twitch client, so a hint explaining what a mention or a block is reads as condescension, and a
hint restating its own label is worse than none -- the dot promises something the tooltip then
fails to deliver. One survives, on the log folder, because what a log file contains is a fact
about this app that nothing on screen reveals. Where two controls genuinely needed telling apart
the fix was the label: "Notify on any mention" became "Notify on your name without the @". A hint
resets case, weight and tracking rather than inheriting them: it hangs inside the label it
explains, and a section heading's small caps were being inherited into whole sentences.

## The window

macOS gets its native frame and every other platform doesn't. `decorations: false` buys a custom
title bar at the cost of square corners and no system shadow, which on macOS reads as a window
from somewhere else; [src-tauri/tauri.macos.conf.json](src-tauri/tauri.macos.conf.json) turns
decorations back on with `titleBarStyle: "Overlay"`, so the system draws the frame and the
traffic lights over our own bar and we draw no window buttons of our own. `IS_MACOS`
([src/lib/tauri.ts](src/lib/tauri.ts)) gates that, the padding the lights land in, and the sizes
of everything else in the row.

The lights are a fixed system size. Apps that shrink them call `setFrameSize` on the buttons
AppKit hands back, which Tauri exposes no way to reach and which is fragile enough that Warp,
which does it, has an open issue about the buttons going unresponsive after an OS update. So they
stay stock and the bar grew around them instead, from 28px to 36. That costs the one thing 28px
was worth: it's the standard title bar height, the height the system centres the lights for, so
any other height has to place them by hand. `trafficLightPosition` does that, and its `y` is not
a distance from the top -- tao resizes the title bar container to `buttonHeight + y` and leaves
the buttons at their own offset inside it, so the value is calibration rather than arithmetic.

Size and position are remembered by `tauri-plugin-window-state`, on three flags rather than its
default `all()`. `DECORATIONS` would let a saved value argue with the config that gives this app
its title bar, and `VISIBLE` can restore a window hidden -- an app that starts invisible and is
only fixable by deleting a file the user has never heard of. The plugin is worth the dependency
for one behaviour that is easy to get wrong alone: it restores a saved position only if a monitor
currently attached intersects it, so unplugging the screen the window was last on leaves the app
opening somewhere you can see.

Keeping the window above the others is a preference like any other, so both the title bar's pin
and the appearance tab write `alwaysOnTop` and the window is told in one place, in
`set_preferences`. It's restored at launch and off by default: a window that won't go behind
anything is an unpleasant thing to inherit from a session you'd forgotten about.

## Updating itself

The whole mechanism is one signed static file. The release workflow builds each platform's
installer, signs it with a minisign key, and merges that platform's entry into a `latest.json`
attached to the GitHub release; `plugins.updater` in `tauri.conf.json` points every installed
copy at `releases/latest/download/latest.json`, and `tauri-plugin-updater` compares versions,
downloads, checks the signature against the public key compiled in, and swaps the app. There is
no service to run. A website would only start earning its place with staged rollouts, a beta
channel, or download numbers, none of which anyone has asked for.

The preferred release trigger is `workflow_dispatch` on `main` after the version commit has been
pushed. The Tauri action still creates the `v<version>` tag and draft release, while keeping the
workflow on the default-branch cache scope lets later releases reuse npm and Rust artifacts;
separate version tags cannot share their own caches. A pushed tag remains a fallback trigger.
Every `npm ci` skips its automatic audit request and prefers cached packages because verification
runs one explicit, retry-protected `npm audit`; install-time audits would duplicate that network
call once per platform without adding a security gate.

That updater signing key is unrelated to Apple's or Microsoft's and the updater never substitutes
platform trust for its own minisign verification. What the key does mean is that **losing the
private half permanently orphans every installed copy** -- they will only accept a download
signed with it, and there is no way to hand them a new one.

**Rust owns it** ([src-tauri/src/updater.rs](src-tauri/src/updater.rs)), not the plugin's JS
API. An update is an HTTPS fetch, a signature check and a filesystem swap, which is the Rust
side of the boundary by the same rule as everything else -- unlike mentions or the emote
blacklists, no part of it depends on which login is reading. Two things settle it beyond that:
the launch check has to run in `setup()` under `diagnostics::supervise` regardless, and granting
`updater:default` would hand the webview permission to download and execute code in an app that
renders arbitrary chat under `csp: null`. Keeping that capability ungranted costs nothing, since
the frontend only ever needs to see a stage and press a button. `capabilities/default.json` is
untouched, and `AppHandle::request_restart` is core Tauri, so there's no process plugin either.

The state is a **snapshot as well as an event**. Every transition goes through one `set()` that
writes `AppState::updates.state` and emits `update://state` with the same value, so the two
can't disagree. Events alone would be wrong: the settings dialog can be opened long after the
launch check finished, or halfway through a download, and has to find the picture already
painted. The dialog re-reads it on mount for exactly that.

Checks and installs also share one asynchronous operation lock. A launch check, manual check and
install cannot overlap and replace one another's pending update or publish contradictory stages.

The first launch of a build also shows a What's New dialog, entirely offline. The frontend imports
`CHANGELOG.md` as build input and extracts only the versioned section that exactly matches
`package.json`; it does not accumulate every release missed since the last run. A test requires
that exact section to exist, so bumping a version without moving `Unreleased` into its dated
release section fails before packaging. `Settings::last_seen_version` records the build only when
the dialog is dismissed. It stays outside `Preferences` because it is launch bookkeeping rather
than a user choice, while Rust still owns its durable write so every other settings save preserves
it. Keeping the notes in the installed bundle means the dialog neither depends on the update
endpoint nor needs network access after an upgrade.

**Windows has no `ready` stage.** `Update::install` hands the installer to `ShellExecuteW` and
exits the process; NSIS puts the app back up on its own. macOS and Linux swap the files in
place and wait to be restarted, which is the only reason the button ever says *Restart*. The
asymmetry is invisible to the user -- the state simply never arrives on Windows -- and nothing
in the frontend has to know about it.

The Windows arguments are `/P /UPDATE /R`, and they're why this fixes the upgrade friction.
`/UPDATE` sets `$UpdateMode` in Tauri's NSIS template, which skips the reinstall page entirely;
`/P` suppresses the "the app is running" box. Running that installer by hand instead gets both.
The friction it replaces came from shipping `.msi` and `-setup.exe` side by side: the NSIS
template detects an `msiexec` uninstall string and force-uninstalls, with no choice offered.
`bundle.targets` now names its formats explicitly and `msi` isn't among them. Anyone still
holding the old MSI gets that forced uninstall once, on the way to the first NSIS build.

Two entries in `bundle.targets` are load-bearing beyond what they look like: `app`, because the
macOS updater artifact is built from the `.app` bundle rather than the `.dmg`, and `appimage`,
which is the only Linux format the bundler will make an updater artifact for. Drop either and
that platform's updates disappear without any error. `deb` and `rpm` update themselves too, which
is worth saying because it looks like they shouldn't: the bundler stamps each binary with the
format it was packaged as, so an installed copy asks `latest.json` for its own key -- they're
all in there, `linux-x86_64-deb` included -- and the plugin hands the download to `dpkg -i`
behind a graphical root prompt rather than swapping a file. Nothing on this side has to tell
them apart.

macOS release builds use a Developer ID Application identity, hardened runtime, secure timestamp,
and Apple notarization, so replacing the app bundle in place no longer invalidates Gatekeeper's
trust and automatic update installation is enabled there. The release job imports the base64
PKCS#12 identity into an isolated temporary keychain and decodes the App Store Connect API key
only under the runner's temporary directory. Tauri signs, notarizes, and staples the app; a
post-build gate then makes `codesign`, `stapler`, and `spctl` independently accept the bundle
before the macOS matrix entry succeeds. A final always-run step deletes both temporary keys.

Apple's signature and notarization are platform trust, while the updater's minisign signature is
update provenance. Both remain required: Gatekeeper recognizing the publisher does not prove that
an update came from the static key compiled into an older ChatWow installation.

**The release matrix is serialized on purpose.** `tauri-action` builds `latest.json` by
downloading the copy already on the release, merging its own platform in, and re-uploading it.
Four jobs finishing together is a lost update -- and the failure is silent and platform-shaped,
one key missing from the file and that platform alone never seeing another update. `max-parallel:
1` is the whole fix.

**Publishing the draft is the act of shipping.** `releases/latest/download/` resolves only to a
published, non-prerelease release, so the draft the workflow leaves is invisible to every
installed copy until someone publishes it -- and the moment they do, every running app finds it
at its next launch. There's no staged rollout and no recall: the NSIS template refuses
downgrades and the updater only offers strictly newer versions, so the only fix for a bad
release is a newer one carrying the old code. `CHATWOW_UPDATE_ENDPOINT` exists for the
rehearsal that makes that unlikely -- point a hand-installed build at a pre-release's own
`latest.json` and watch it update before anything reaches `latest`. It's safe to leave in a
shipped build, since the public key is compiled in and a redirected endpoint still can't produce
a download signed with the right key.

The affordance is a dot on the settings cog, not a line in chat. Announcing it as a
`localNotice`, the way 7TV set events and `announce_drop` do, fits the house style
better -- but a notice scrolls away in a busy channel, and would either be seen once and lost or
repeat in every tab. The dot persists until it's acted on, and it's an absolutely positioned
overlay inside the cog's existing fixed box: it must never change what the title bar measures.

## Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/src/irc/parse.rs` | IRCv3 line + tag parser |
| `src-tauri/src/irc/client.rs` | A socket per account: reconnect, `sync`, per-session asset loading |
| `src-tauri/src/irc/history.rs` | The recent-messages backlog fetched on join |
| `src-tauri/src/render.rs` | Emote ranges, overlay folding, badge and segment resolution |
| `src-tauri/src/color.rs` | Twitch default color palette + dark-background readability lift |
| `src-tauri/src/emotes/seventv.rs` | 7TV v3 global and channel emote sets |
| `src-tauri/src/emotes/bttv.rs` | BetterTTV global, channel and shared emotes |
| `src-tauri/src/emotes/ffz.rs` | FrankerFaceZ global and room sets |
| `src-tauri/src/emotes/seventv_badges.rs` | 7TV badges, batched per chatter over GraphQL |
| `src-tauri/src/emotes/cache.rs` | Bounded on-disk emote and badge images, served over `emote://` |
| `src-tauri/src/emotes/catalog.rs` | Stale-while-revalidate provider catalog snapshots |
| `src-tauri/src/badge_cache.rs` | Persistent Twitch definitions and expiring 7TV badge answers |
| `src-tauri/src/twitch/badges.rs` | Helix global and channel badges |
| `src-tauri/src/twitch/emotes.rs` | Helix emote names, for completion only |
| `src-tauri/src/twitch/commands.rs` | Every slash command, as its Helix call |
| `src-tauri/src/twitch/eventsub.rs` | The whisper socket, one per account |
| `src-tauri/src/usercard.rs` | The card behind a name: Helix profile, ivr.fi follow and subs |
| `src-tauri/src/linkinfo.rs` | Link previews: the fetch, the meta scan, the YouTube fields |
| `src-tauri/src/emotes/seventv_links.rs` | A 7TV emote link, previewed as the emote |
| `src-tauri/src/twitch/links.rs` | Twitch clips, VODs and channels, out of Helix |
| `src-tauri/src/auth.rs` | OAuth device code flow, permission groups |
| `src-tauri/src/state.rs` | Accounts, connections, per-room data and per-session state |
| `src-tauri/src/settings.rs` | `settings.json`: accounts, tabs, emote counts, preferences; migration |
| `src/store/chat.ts` | Zustand store, per-channel 500-message ring buffer, pane layout |
| `src/store/tabDrag.ts` | The tab being dragged, shared by both panes |
| `src/components/Panes.tsx` | One pane or two, the divider, and the empty-pane screen |
| `src/components/AccountMenu.tsx` | The tab's (and composer's) account picker |
| `src/components/AccountPanel.tsx` | The accounts manager, permissions, and the Client ID |
| `src/lib/commands.ts` | The command catalog the `/` picker reads |
| `src/lib/emoteComplete.ts` | Completion cycling, picker search and ranking |
| `src/lib/chatterComplete.ts` | Chatters seen this session, matched for `@` and Tab |
| `src/lib/mentions.ts` | Whether (and how) a message names the signed-in user |
| `src/lib/ignores.ts` | The mention-ignore and blocked-user lists, and what they match |
| `src/lib/userCard.ts` | User-card session cache and the "14 years ago" phrasing |
| `src/lib/links.ts` | What kind of link this is, and which preview switch it answers to |
| `src/lib/linkPreviews.ts` | Link-preview session cache, and the shelf life Rust sets |
| `src/lib/notify.ts` | The synthesized mention ping |
| `src/lib/themes.ts` | Built-in theme catalog and semantic color-token mapping |
| `src/lib/emoji.ts` | Lazy-loaded emoji list and name search |
| `src/components/` | Title bar, tabs, chat view, composer, pickers, user card, settings |
| `src-tauri/src/updater.rs` | The update check, download and restart |
| `src/lib/tauri.ts` | Whether this is the real app, whether it's macOS, and the bar's height |
| `scripts/generate-emoji.py` | Regenerates `src/lib/emoji.json` from Unicode |
| `scripts/bump-version.py` | Sets the version in the five files that have to agree |

## Diagnostics

Nothing this app knew used to survive it. Rust's diagnostics went to stderr, which under
`npm run tauri dev` means a terminal you may have closed and in a bundled `.app` means nowhere at
all; an exception in the webview stayed in a devtools console nobody had open; and a panic inside
a spawned task was delivered to a `JoinHandle` nothing awaits, so the socket simply stopped with
the window still up and nothing said anywhere. [diagnostics.rs](src-tauri/src/diagnostics.rs) is
the answer to all three.

`tauri-plugin-log` writes one file in the OS's own log directory --
`~/Library/Logs/io.github.chetwow.chatwow/chatwow.log` on macOS,
`%LOCALAPPDATA%\io.github.chetwow.chatwow\logs\` on Windows -- rotating at 5MB and keeping
three, so it can neither fill a disk nor have thrown away the run you came to read about. The
level is set twice on purpose: everything defaults to `Warn` and only `chatwow_lib` and the
webview target get the chosen level, because `CHATWOW_LOG=debug` is otherwise unusable -- rustls,
hyper and tungstenite between them say more per second at debug than a whole session of ours
does. Stdout stays a target as well, since under `tauri dev` the terminal is still the fastest
place to read.

`install_panic_hook` chains rather than replaces the default hook, so the familiar message still
reaches the terminal, and writes the panic, the thread and a forced backtrace to the log first --
forced because nobody who double-clicked the app set `RUST_BACKTRACE`. It has to go up *after*
the plugin, or the logger it writes into doesn't exist yet and the first panic is the one that
goes missing.

`supervise` replaces `tauri::async_runtime::spawn` for the long-lived tasks -- the IRC sockets,
the whisper sockets, the 7TV event socket, the pollers, the badge resolver, the asset loads. It
catches the unwind and names the task that stopped; the hook has already written why. Nothing is
restarted: each of these already has its own retry loop for the failures it expects, so reaching
that line means an assumption broke rather than a network did, and running it again over state it
may have left half-written is a worse answer than a line in the log. The whisper sockets are the
one exception and are spawned directly, because their handles are deliberately aborted whenever
the accounts change and `supervise` would report each of those as a task ending.

The webview half is [src/lib/diagnostics.ts](src/lib/diagnostics.ts): `error` and
`unhandledrejection` listeners installed before the first render, forwarding through the plugin's
JS side into the same file. React 19 reports an uncaught render error through `reportError`,
which arrives as an ordinary `error` event, so a broken component lands there too. Two things
about that turned out to matter only once it was run against the real webview. The bracketed
source the plugin stamps on each line is derived from *our* stack at the point of the call, so it
names `diagnostics.ts` however the file is arranged and can't be made to point at what threw --
everything worth reading therefore goes in the message text. And `Error.prototype.stack`
disagrees across engines: V8 starts it with `Error: message` where JavaScriptCore, which is what
renders this on macOS, gives the frames alone. Reading `stack` and trusting it drops the message
entirely on macOS, so `describe` composes the two halves itself.

What the file must never hold is the two things worth keeping out of something a user might paste
into an issue: an access token, and the text of anybody's messages. Log the shape of what
happened -- which channel, which account's login, which url failed -- and not its contents. That
is what lets Settings -> General offer to reveal the folder, through the `open_log_dir` command,
without a warning attached.

## Tests

```bash
cd src-tauri && cargo test
```

Covers tag unescaping, code-point emote ranges, zero-width overlay folding, badge lookup
fallbacks, the default color hash, emote-index ordering and use counting, command argument
parsing, the backlog's filtering, the image cache's key validation, content-type sniffing and
recency selection, catalog fallback, expiry and bounds, the 7TV event dispatches -- how one reads back as
added, removed or renamed,
and what folding it into a channel does to the merged map -- and, for link previews, the
meta-tag scan, the entity decoding, YouTube and Twitch url recognition, the count and duration
formatting, and the refusal to fetch this machine's own network.

`cargo test -- --ignored` additionally hits the real APIs: one check runs a message through the
whole pipeline off the live Twitch socket and 7TV, another parses the BetterTTV and FrankerFaceZ
sets for real channels, a third resolves 7TV badges for users who do and don't have one, a fourth
loads a user card unauthenticated -- the path with no Helix token, where ivr.fi answers both
halves -- a fifth reads real pages for previews, including the YouTube card whose every row
comes from a different part of the page, and a sixth opens the 7TV event socket and checks that
a real channel's emote set is something 7TV will accept a subscription for, which is the half
of that protocol no offline test can cover. A seventh covers Twitch's own links and needs a
token, so it skips unless `TWITCH_TEST_CLIENT_ID` and `TWITCH_TEST_TOKEN` are set. Those are
the ones that catch a provider changing its response shape -- the symptom is an empty map,
which is indistinguishable from a channel that simply has no emotes there.

`npm test` runs the Vitest frontend regression suite, and `npm run build` type-checks and bundles
the production UI. The release workflow runs both, plus Rust formatting, strict Clippy and the
Rust unit suite and npm/RustSec dependency audits, before any platform installer job can begin.
