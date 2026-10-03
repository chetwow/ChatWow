# Authentication

[Architecture map](../../ARCHITECTURE.md)

Sources: [auth.rs](../../src-tauri/src/auth.rs), token worker in
[lib.rs](../../src-tauri/src/lib.rs), [AccountPanel.tsx](../../src/components/AccountPanel.tsx),
[permissions.ts](../../src/lib/permissions.ts).

## Accounts and permissions

The app uses Twitch's device code flow with a public Client ID and no client secret.
[build.rs](../../src-tauri/build.rs) provides the default Client ID; `TWITCH_CLIENT_ID` overrides
it at build time. The runtime override in Accounts settings covers every account. Changing it
signs accounts out because their tokens belong to the previous Client ID; tabs remain anonymous.
The change and account removal are atomic, and an in-flight device grant for the old Client ID
cannot reinsert an account afterward. Frontend sign-in generations also discard stale initialization
and poll responses after cancellation/replacement. Device `slow_down` increases the polling
interval by five seconds for each subsequent request rather than being treated as ordinary pending.

Anonymous is the empty account ID, a supported per-tab choice. Losing an account makes its
channel tabs anonymous rather than closing them. Each authenticated account with channel tabs
has its own IRC connection and EventSub socket. Every incoming message is stamped with the
receiving account so duplicate channel tabs receive the correct copy.

`PERMISSION_GROUPS` defines requested scope groups. Shared `permission_groups` selects what the
next sign-in requests; each account's validated `scopes` defines what it can actually do.
The Accounts UI keeps separate drafts keyed by account and granted scopes, and saves the draft
immediately before beginning authorization. New-account drafts enable all four groups.
Never use selected checkboxes as proof of granted capability. Optional scope changes require
reauthorization, and moderator scopes do not confer a channel role.

Sending and moderation use the tab's `Auth::credentials(account)`. Public metadata such as
stream state, avatars, badges, and link previews can use `Auth::any_credentials`. Twitch emote
completion uses account credentials but its catalogs do not represent subscriber entitlements.

## Token lifecycle

One token worker validates at startup, hourly, and after wake/rejection signals. It refreshes
tokens with less than ninety minutes remaining, using Twitch's validation response rather than
a locally stored deadline. IRC and EventSub notify this worker; they never exchange refresh
tokens themselves.

- Routine validation/renewal keeps healthy sockets alive. IRC reads current credentials on its
  next connection; EventSub subscription requests read them on each HTTP call.
- Startup credential replacement, completed wake recovery, and account loss rebuild connections.
- Transport/server failures retain the account and retry after five seconds. A rejected refresh
  invalidates it. Failed validation alone is not evidence that a refresh grant was rejected.
- If renewal rotates credentials but subsequent validation fails, persist the new pair before
  retrying. Commit results only if the checked credential snapshot is still current, so an
  in-flight request cannot overwrite a newer sign-in.
- Coalesce rejection signals with a five-second minimum between passes. Recreating healthy
  EventSub sockets on ordinary metadata updates can exhaust Twitch's subscription limit.

Tokens reside in the per-user `settings.json`. Unix directory/file permissions are `0700`/`0600`;
Windows relies on the user's AppData ACL. [Runtime](runtime.md) describes atomic persistence and
diagnostic restrictions.
