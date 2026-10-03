# Messaging

[Architecture map](../../ARCHITECTURE.md)

Sources: [IRC client](../../src-tauri/src/irc/client.rs), [history](../../src-tauri/src/irc/history.rs),
[renderer](../../src-tauri/src/render.rs), [EventSub](../../src-tauri/src/twitch/eventsub.rs),
[chat events](../../src-tauri/src/twitch/chat_events.rs), [pins](../../src-tauri/src/twitch/pins.rs).

## Joining and reconnecting

Room emotes/badges are shared; readiness, buffered messages, roles, and history are per account/
channel session. A join optionally fetches up to 150 raw IRC messages from
`recent-messages.robotty.de` through the ordinary parser and renderer. Failure leaves a usable
live chat. The General history preference disables both join backlog and reconnect recovery;
it does not disable unrelated provider, preview, user-card, or update requests.

A session stays unready while history loads and while buffered live messages are queued.
That transition happens under its write lock. Deduplicate overlap by Twitch message ID and
prefer the live copy. Replayed rows are dimmed and never cause unread counts, listener collection,
or sounds. Account/channel sessions load their own backlog even if another account has the
room's assets already.

Disconnection emits a notice and freezes `last_seen` into `interrupted_at`. Recovery must use
that frozen point, not a timestamp advanced by new live traffic. On rejoin, check interruption
before ordinary first-join readiness; recovered history is queued before buffered live traffic
and the reconnect notice. Connection and load generations prevent obsolete sockets/loaders
from removing or committing into replacement sessions.

The sleep watchdog samples wall time every fifteen seconds; a gap of at least forty-five
seconds requests recovery. Anonymous IRC reconnects immediately. Authenticated recovery waits
for the sole [token worker](authentication.md#token-lifecycle), then reconnects IRC, restarts
EventSub, and refreshes live state. Wall time includes sleep on platforms whose monotonic clock
does not. Connect/login/write operations have ten-second bounds; a WebSocket ping every thirty
seconds requires its matching pong within ten seconds to detect shorter half-open failures.

## Sending, commands, and moderation

[Composer.tsx](../../src/components/Composer.tsx) sends through Helix chat messages using the
tab's account and `user:write:chat`; there is no local echo. The IRC echo supplies the real
message ID, badge/emote resolution, and reply tags. Replies send `reply_parent_message_id`.
`/me` uses this send path; other slash commands map to Helix in
[commands.rs](../../src-tauri/src/twitch/commands.rs).

The frontend [command catalog](../../src/lib/commands.ts) must agree with backend command
requirements. Picker availability combines granted scopes with the session's IRC `USERSTATE`
role; an unknown role is a viewer. Commands missing only a scope stay discoverable for
reauthorization. Failed sends/commands preserve the draft. `/mods` and `/vips` require the
tab account to be the broadcaster.

Listener-message moderation selects a moderator/broadcaster channel tab, preferring the account
that received the message, and then uses that tab's scopes. Session-only moderation records are
keyed by channel/login; timeouts expire and confirmed unbans clear the record. `CLEARCHAT` and
`CLEARMSG` update retained channel and listener rows and emit notices without deleted text.

## Notices and EventSub

IRC `USERNOTICE` shares parsing, resolution, history, and batching with chat. Use Twitch's
nonblank `system-msg`, otherwise derive a readable fallback from the notice type/tags, including
shared-chat wrappers. Keep user comments separate so their emote ranges remain valid.
Initial `ROOMSTATE` is silent; subsequent partial updates announce changed modes only.

`chat_events` derives subscriptions from open tabs, known room IDs, account roles, and granted
scopes. One EventSub socket per eligible account carries whispers and applicable channel events.
Never borrow another account's moderator/broadcaster credentials to populate a viewer tab.
Avoid standalone subscriptions/actions already covered by `channel.moderate` or IRC.

Subscriptions reconcile in place, at most one HTTP operation per tick, with an eight-second
request bound and five-minute failure/revocation backoff. HTTP 401 signals the token worker and
ends the failed socket attempt. The supervisor owns restart notification and removes sockets
when their final channel tab closes. During server handover, drain the old socket until the new
one welcomes; keepalive deadlines detect silence. Deduplicate delivery IDs in a bounded window.

AutoMod notices require the payload sender to match the receiving account and do not enter
listener logs; held text is never echoed publicly. Confirmed unban/untimeout notices carry
`unbannedLogin` metadata rather than relying on parsing display text.

Whispers have no channel: route them to the receiving account's focused channel tab, or its
first channel tab. Legacy listeners collect that account's whispers; custom channel listeners
do not. Resolve third-party global emotes, links, mentions, and optional 7TV badges; EventSub
provides no Twitch emote ranges or badges. Notification rules are in [listeners](listeners.md).

## Pinned messages

Public pins live in shared `ChannelData`. An anonymous query to Twitch's undocumented web
GraphQL interface uses the public web Client ID, never account tokens/cookies/integrity data.
Poll joined rooms every fifteen seconds, with four requests in flight, eight-second timeouts,
and 256 KB response caps. Empty success clears a pin; failures retain the last answer for up
to a minute. Both frontend wall-clock expiry and backend snapshots exclude expired pins.

Pin fragments adapt to the normal renderer but bypass ingest: no timeline copy, sounds, unread,
or listener backfill. [PinnedMessagePanel.tsx](../../src/components/PinnedMessagePanel.tsx) sits
outside the scrolling transcript, honors provider/block rules, and tracks session dismissals by
tab and pin ID. Duration updates keep a dismissal; a different pin is visible automatically.
