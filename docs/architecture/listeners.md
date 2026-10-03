# Listeners and notifications

[Architecture map](../../ARCHITECTURE.md)

Sources: [mentions.ts](../../src/lib/mentions.ts), [ignores.ts](../../src/lib/ignores.ts),
[chat store](../../src/store/chat.ts), [notificationSound.ts](../../src/lib/notificationSound.ts),
[notify.ts](../../src/lib/notify.ts), [mentionMarkers.ts](../../src/lib/mentionMarkers.ts).

## Matching and collection

`isAboutYou` matches whole-word names case-insensitively, with or without `@`, and replies to
the selected account; that account's own messages never match. Channel highlighting uses the
tab's account, so two accounts in the same room can produce different highlights.

A custom listener is an ordinary `kind: "mentions"` tab with an empty channel and a `mention`
definition: name, source channels, selected account IDs, followed logins, phrases, and notification
flag. A selected channel is required, plus at least one account, followed user, or phrase.
Within selected channels its matching branches are ORed:

- A selected account is addressed through `isAboutYou`.
- A followed login authored the message, case-insensitively.
- Visible message text contains a phrase, case-insensitively. This branch excludes every
  currently signed-in account's own messages.

Selected accounts are matching identities, not connection filters. Copies received by multiple
accounts collapse to one listener row by message ID. Ingest accepts only live, non-ignored
matches; notice rows, replayed history, recovery backlog, and channel-less whispers do not enter
custom listener logs.

New listeners start empty. The chatter-name/user-card shortcut is the sole backfill exception:
it seeds that user's retained live channel messages and defaults notifications off. Renames and
filter edits preserve existing rows and affect future matching only. Moderation updates rewrite
every affected log. Listener views use the clicked message's channel for user cards/moderation;
they have no composer or Reply action because they have no single destination.

Listeners do not own connections. Closing their last source channel stops collection until it
reopens; all close paths share the optional last-source warning. Legacy `mention: None` tabs
retain one account's mentions/replies/whispers but also do not keep connections alive.

## Counts and sound

Only live `chat` and `whisper` rows add numeric unread badges. Visible tabs in all active panes
are read; notices, system events, and historical rows never increment unread.
Custom listener notifications gate sound and the rose mention badge, while ordinary unread and
collection continue when notifications are off.

Mention-kind switches and situational mutes gate sound independently of matching and counts.
Ordinary mentions in visible panes are silent by default; whispers keep their exception unless
the window-active mute applies. The title-bar mute overrides all sound. At most one ping plays
per batch, with a minimum 1.5-second gap.

| Preference | Effect |
| --- | --- |
| `notificationMutes` | Sound only; keep highlights, badges, collection |
| `mentionIgnores` | Remove sound, mention count/highlight, and listener collection; keep channel row |
| `blockedUsers` | Hide the row entirely and imply ignoring |

Mute/ignore entries normalize `@login` and `#channel`; bare words mean a user. Channel rules
do not suppress whispers, whose displayed channel is only a routing destination. Lists are
shared across accounts and local to ChatWow, with no Twitch block API calls.

Channel scrollbar markers reuse the row's mention/ignore/block decision, measure variable row
positions, and yield pointer input to the native scrollbar thumb. Listener tabs omit this rail.
