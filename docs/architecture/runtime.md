# Runtime and state

[Architecture map](../../ARCHITECTURE.md)

| Entry point | Responsibility |
| --- | --- |
| [lib.rs](../../src-tauri/src/lib.rs) | Tauri setup, commands, token/live pollers |
| [state.rs](../../src-tauri/src/state.rs) | Shared accounts, connections, rooms, sessions |
| [settings.rs](../../src-tauri/src/settings.rs) | Durable settings and migration |
| [windows.rs](../../src-tauri/src/windows.rs) | Window ownership, ordered events, preference routing |
| [App.tsx](../../src/App.tsx) | Frontend bootstrap and app-level interactions |
| [chat.ts](../../src/store/chat.ts) | Message ingestion and per-tab/pane state |
| [types.ts](../../src/types.ts) | Hand-mirrored Rust IPC types |

## Ownership and IPC

Rust parses incoming messages and resolves badges and body segments before emitting them.
The frontend computes account-dependent mentions and render-time provider/blacklist choices,
so changing preferences or accounts can update retained immutable messages without re-fetching them.
IRC batches messages every 80 ms. [backendEvents.ts](../../src/lib/backendEvents.ts) consumes the
sequenced `window://event` stream; transfer snapshots and gap replay are described under
[windows](windows.md#event-replay-and-transfer).

Tab IDs identify views, including duplicate channel tabs. Account/channel pairs identify IRC
sessions; channel logins identify shared room assets. `AppState::wanted` derives connections from
channel tabs only. Listener tabs never keep a socket or a joined room alive.
Each webview has its own Zustand stores; durable/shared changes go through Rust.

Retained chat arrays are trimmed to 500 rows after crossing 600. Sent-message history, listener
logs, read state, and focus are frontend state; tab transfers explicitly carry the applicable
retained data. Transcript history is not a durable chat archive.

## Persistence and asynchronous work

Preference updates contain changed fields, merge under a serialized update lock, and broadcast
the resulting state. [Windows](windows.md) owns the list of local preference keys. Complete
settings snapshots are saved through a private temporary file, synced, and atomically replaced.
Missing settings mean first run; malformed settings are preserved as `settings.invalid-*.json`
before defaults are used. Legacy account/tab fields migrate once and are omitted on later saves.
Frontend normalization handles preference bounds and unknown choice values.

Tauri's synchronous setup callback has no Tokio runtime context: start asynchronous work through
Tauri's runtime. Never hold a `parking_lot` guard across an await; clone owned inputs first.
Room asset loading and updater operations use async mutexes where a lock must span awaits.

[diagnostics.rs](../../src-tauri/src/diagnostics.rs) installs the logger and then a chained panic
hook. `supervise` names panicked long-lived tasks without restarting potentially inconsistent
state; expected network failures belong to each task's retry loop. EventSub account tasks retain
abort handles under their supervisor. Frontend errors and rejected promises enter the same log
through [diagnostics.ts](../../src/lib/diagnostics.ts), including both error message and stack
because JavaScriptCore does not put the message in its stack string.

Logs must omit access/refresh tokens and chat contents. See [development](../development.md)
for log locations and development-only lifecycle recovery.
