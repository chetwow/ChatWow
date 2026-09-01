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

Two details it's easy to get wrong. The fetch happens *before* the session is marked ready, so
live messages keep buffering and the backlog can be placed above them rather than under them.
And the history runs up to now while the buffer starts partway through it, so the two overlap by
however long the fetches took -- Twitch's message ids settle that exactly.

It's fetched per *session*, not per channel: a second account opening a channel the first is
already in is a fresh join with its own backlog, even though the room's emotes and badges are
already in hand ([Accounts and tabs](#accounts-and-tabs)).

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
before a box was ticked simply doesn't have it, the accounts panel names which accounts hold
each group rather than answering yes or no, and every scope check takes an account -- two tabs on
one channel can honestly offer different commands.

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
config directory, one entry per account.

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

`isAboutYou` in [src/lib/mentions.ts](src/lib/mentions.ts) is the single answer to "is chat
talking to me": named, or replied to, and never your own message. The row highlight and the
mentions tab below both read it, so a message can't be one and not the other.

Which "me" is the tab's, not the app's: it takes the login of the account that tab reads as, so
the same message highlights in one tab and passes unremarked in the one beside it on the same
channel. That's also why it lives in the frontend rather than in `render.rs` -- it depends on
who's signed in, which changes without the already-resolved backlog being rebuilt.

## The mentions tab

A tab that isn't a channel: everything addressed to one account, from everywhere, in one list.
Opened from the join dialog (which offers it whenever the account you're joining as hasn't got
one and nothing has been typed) and stored in `tabs` like any other, so it survives a restart.

It's an ordinary `Tab` with `kind: "mentions"` and an empty channel -- not a sentinel key beside
the real ones. That's what lets it share `active`, `unread`, `mentions` and the whole tab bar
with the channel tabs and behave like one everywhere those are read: selecting it clears its
counts, its badge is drawn by the same code, dragging and wrapping measure it like any other,
`Ctrl+W` closes it through the same call. The only thing it does differently is render
`mentionLog[account]` instead of `messages[id]`, and have no composer -- there's no one room a
message typed into it would belong to.

There is one per account, because a mention is addressed to a login: what names one of yours
names only that one. Two accounts, two possible mentions tabs, each collecting its own.

One exemption: the rose bar at a scrolled-off edge skips it. That bar means "something past this
edge named you", and pointing at the tab those are already gathered in says nothing you didn't
know.

The messages live in `mentionLog`, appended in `ingest` from the same pass that files them into
their channels, and kept whether or not the tab is open -- opening it shouldn't open an empty
pane. A message enters the log as the same object (same `key`) its channel holds, so a row shown
in both places is one memoized component rather than two that happen to look alike. A deletion
has to reach both copies, which is why `clear` rewrites the log as well: a timed-out mention left
standing in the one place you'd go looking for it is worse than not having the tab.

Replayed backlog never lands there. It arrives stamped older than what's already in the list, so
a channel joined at noon would file this morning's mentions below this minute's -- and the same
rule already keeps it from pinging or counting as unread.

[ChatView.tsx](src/components/ChatView.tsx) renders it with the same scroller, context menu and
user cards as a channel; only the source and the composer differ. There's no composer because
there's no one channel to send to -- the row's channel chip is the way back to one -- and Reply
is dropped from the context menu for the same reason. The user card takes its channel from the
clicked *message* rather than the view, which is what keeps the follow and subscription lines
about the channel the message was actually said in.

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

A tab deliberately doesn't say which account it reads as. The row is scanned for channel names,
and a second word on every tab costs more room than it buys -- the question is answered where
it's asked instead: the right-click menu ticks the current account, and the composer names the
one it sends as twice over, in its placeholder and in the avatar beside it. The avatar is the
half that survives typing, which is what it's for -- with the same channel open under two
accounts the tabs look alike, and the placeholder is gone by the second character.

Right-clicking a tab (or the composer, which is the same tab speaking) opens
[AccountMenu.tsx](src/components/AccountMenu.tsx): every account, Anonymous, and Close tab.
Clicking the composer's avatar opens the same menu, and is the only way in when the tab is
anonymous -- a disabled input takes no mouse events at all, so the right-click never reaches it.
It's a control's menu rather than a message's, so it doesn't close when chat scrolls underneath
-- see `closeOnScroll` on `ContextMenu`, which the split menu needs for the same reason.

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

`Ctrl/Cmd+W` closing a tab is why the macOS menu bar is built by hand
([`macos_menu`](src-tauri/src/lib.rs)): Tauri's default menu binds `Cmd+W` to Close Window, and
a menu key equivalent is matched before the keystroke ever reaches the webview.

## Accounts and tabs

Several Twitch accounts can be signed in at once, and **a tab picks one**. That single
sentence is what re-keys the app: the same channel can be open twice under two logins, so a
channel name no longer identifies a view. A `settings::Tab` -- `{ id, kind, channel, account }`
-- does, and everything kept per view (messages, unread, scroll position, sent history,
completable emotes, role) is keyed by its id. `channel` still keys what belongs to the *room*:
emote sets, badge sets, room id, who's live.

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
  message highlights in one tab and not in the one beside it. Mention logs are per account for
  the same reason, which is why a mentions tab belongs to an account like any other tab.

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

The split menu hangs off a title-bar button, which is why `ContextMenu` grew `closeOnScroll`.
A menu opened *on* a message has to close when chat scrolls out from under it; a menu belonging
to a fixed control must not, or it would be unopenable in a busy channel -- chat scrolls itself
every time a message lands.

## Message history

`↑` in the composer walks back through what you've sent in the current channel, `↓` comes
forward again; stepping past the newest entry restores whatever you'd half-typed when the walk
started, and typing over a recalled message ends the walk so the next `↑` starts from the top.
History is per channel and lives only for the session, and a repeat of the previous message
doesn't add a second entry. The emote picker takes the arrows first while it's open.

## Emote providers

Three services, plus Twitch's own emotes: 7TV
([src-tauri/src/emotes/seventv.rs](src-tauri/src/emotes/seventv.rs)), BetterTTV
([bttv.rs](src-tauri/src/emotes/bttv.rs)) and FrankerFaceZ
([ffz.rs](src-tauri/src/emotes/ffz.rs)). Each is asked for its global set once at startup and for
a channel's set on join, by Twitch user id; the three run concurrently, and a provider that's
down, slow or has never heard of the channel yields an empty map rather than an error -- a
channel with no BTTV account 404s, which is the common case, not a failure.

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

The results are pushed to the frontend as `chat://seventv-badges` and kept in the store, *not*
folded into the messages: a badge lands after the message that prompted the lookup, and stored
messages are immutable, so a row that already rendered would never get one. `MessageRow`
subscribes to its own chatter's entry instead, which also makes the Appearance toggle apply to
the backlog immediately. Switching it back on clears the "already asked" set, so people are
resolved again as they talk -- the badges the frontend already holds stay put meanwhile, so
familiar faces keep theirs.

## User cards

Clicking a name opens [UserCard.tsx](src/components/UserCard.tsx). Its top half is fetched, its
bottom half is free -- the messages that chatter has already sent in this tab, filtered out of
the store. That log is one tab only: the same name in two tabs is two conversations.

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

**An image link is answered locally.** `imagePreviewUrl` ([src/lib/links.ts](src/lib/links.ts))
tests the extension on the url's own path -- no request, no host list -- and the preview is an
`<img>` at that url. That misses an image served from an extensionless url, which is the right
side to fail on: a miss leaves the link behaving as it always did, where a guess draws an empty
frame over a page that was never an image.

**Everything else has to be asked**, and that's [src-tauri/src/linkinfo.rs](src-tauri/src/linkinfo.rs):
one GET, and the page's own account of itself out of the head -- OpenGraph first, then Twitter's
copy of it, then the plain `<title>`. Those tags exist for exactly this, which is why the preview
is a scan for `<meta>` and not an HTML parse: two fields don't justify a parser, and titles and
meta tags are the two things a scan can find without meeting anything that would fool it.

It's the only fetch in the app whose address a stranger chose, so it doesn't share
`AppState::http`. `link_http` is built with a redirect policy that refuses, hop by hop, anything
that isn't `http(s)` on a public host -- not `localhost`, not a private or loopback literal, in
either address family -- an eight-second timeout, and a body read in chunks and stopped the
moment it holds what's wanted. For most of the web that's the few KB up to `</head>`, with 256KB
as the ceiling for pages that bury it. The host check is on the literal in the url: a *name*
resolving to a private address still gets through, which would mean owning DNS resolution to
prevent, a great deal of machinery for a threat that ends at "a page title was fetched".

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
request, so the wait reads as a wait rather than as nothing happening. A preview that arrives
after the pointer has left is dropped, by comparing a counter bumped on every `mouseleave`. And
answers are cached for the session either way ([src/lib/linkPreviews.ts](src/lib/linkPreviews.ts))
-- "this link has no preview" is an answer, and hovering the same link twice shouldn't ask twice
-- with a cap, since chat is endless where the user cards are a handful of names you clicked. A
cached link draws with no spinner at all, since there's nothing to wait for.

`previewImages`, `previewYoutube`, `previewTwitch` and `previewPages` are four preferences
because the four cost different things: one request to the host in the link; a megabyte read off
YouTube; a Helix call carrying your token; a request to a stranger's host and a thumbnail from
wherever it names. Splitting them is what lets someone keep the cheap ones and drop the rest.

Which switch applies is decided by the *link*, before anything is asked, so `linkKind`
([src/lib/links.ts](src/lib/links.ts)) classifies by extension and host alone. That's coarser
than what the resolvers do -- `twitch.tv/directory` is a Twitch link to the switch and an
ordinary page to Rust -- and deliberately so: the switch is about where the request goes, and
that one goes to Twitch either way.

All four gate the frontend, not Rust: `link_preview` fetches whatever it's handed, so a switch
has to stop the call rather than the request. Nothing else reads them, and a message already on
screen picks up the change because `LinkView` subscribes to the store instead of taking a prop --
the same reason the emote blacklists do.

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

Chatter names are matched against both login and display name, ordered alphabetically, and always
inserted with the display name's own casing. The candidate list is built from incoming messages
and lasts only for the session: Twitch gives a plain chat client no roster to read, and a stale
name is worse than a missing one when you're replying to someone. You're never in your own list.

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

## Emote images on disk

Emote images are cached under the app's cache directory and served to the webview over an
`emote://` scheme handled in Rust, so a busy channel stops re-fetching the same emotes. Files are
keyed by **provider id, not name** — 7TV emotes are aliased per channel, so a name is neither
stable nor unique. The cache fills lazily (an emote is stored the first time it's actually
displayed), and a miss or failure falls back to the CDN url. Images that no joined channel can
reach any more are purged once every channel's set has loaded -- purging on a partial picture
would evict images the other channels are about to ask for.

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
[src/types.ts](src/types.ts), read at startup and written whole on every change. Rust
deliberately doesn't validate the values: the store normalizes an unknown one back to the
default, so a hand-edited file can't wedge the UI. The font-size preset resolves to a
`--chat-font-size` custom property set on the app root; only message bodies and the composer
follow it, so nothing that measures its own layout moves when it changes. Mock mode has no
backend to write to and falls back to `localStorage`.

The dialog is sized for the window's 420px minimum: the panel is `min(560px, 100%)`, setting rows
wrap their control under the label when they have to, and the tab row scrolls sideways rather
than wrapping to a second row that would push content off the bottom. Its height is fixed to the
window rather than the content, so switching tabs doesn't resize it. The settings that need
explaining carry an info dot on the label -- history, the four link-preview switches, the blocked
and ignored lists, the two emote blacklists, the notification toggles -- and the ones whose label
is the whole story don't, which keeps the list scannable. A hint resets case, weight and tracking
rather than inheriting them: it hangs inside the label it explains, and a section heading's small
caps were being inherited into whole sentences.

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
| `src-tauri/src/emotes/cache.rs` | On-disk emote images, served over `emote://` |
| `src-tauri/src/twitch/badges.rs` | Helix global and channel badges |
| `src-tauri/src/twitch/emotes.rs` | Helix emote names, for completion only |
| `src-tauri/src/twitch/commands.rs` | Every slash command, as its Helix call |
| `src-tauri/src/twitch/eventsub.rs` | The whisper socket, one per account |
| `src-tauri/src/usercard.rs` | The card behind a name: Helix profile, ivr.fi follow and subs |
| `src-tauri/src/linkinfo.rs` | Link previews: the fetch, the meta scan, the YouTube fields |
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
| `src/lib/emoji.ts` | Lazy-loaded emoji list and name search |
| `src/components/` | Title bar, tabs, chat view, composer, pickers, user card, settings |
| `scripts/generate-emoji.py` | Regenerates `src/lib/emoji.json` from Unicode |

## Tests

```bash
cd src-tauri && cargo test
```

Covers tag unescaping, code-point emote ranges, zero-width overlay folding, badge lookup
fallbacks, the default color hash, emote-index ordering and use counting, command argument
parsing, the backlog's filtering, the image cache's key validation, content-type sniffing and
purge selection, and -- for link previews -- the meta-tag scan, the entity decoding, YouTube and
Twitch url recognition, the count and duration formatting, and the refusal to fetch this
machine's own network.

`cargo test -- --ignored` additionally hits the real APIs: one check runs a message through the
whole pipeline off the live Twitch socket and 7TV, another parses the BetterTTV and FrankerFaceZ
sets for real channels, a third resolves 7TV badges for users who do and don't have one, a fourth
loads a user card unauthenticated -- the path with no Helix token, where ivr.fi answers both
halves -- and a fifth reads real pages for previews, including the YouTube card whose every row
comes from a different part of the page. A sixth covers Twitch's own links and needs a token, so
it skips unless `TWITCH_TEST_CLIENT_ID` and `TWITCH_TEST_TOKEN` are set. Those are the ones that
catch a provider changing its response shape -- the symptom is an empty map, which is
indistinguishable from a channel that simply has no emotes there.

The frontend has no test suite; `npm run build` type-checks it.
