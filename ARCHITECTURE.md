# Architecture

ChatWow is a Tauri desktop app: Rust owns network connections, credentials, persistence, and
message resolution; React renders resolved messages and manages each window's interaction state.

```text
Twitch IRC / EventSub + emote providers
             ↓
Rust: parse → resolve → batch → sequenced window events
             ↓
React: per-window store → panes/tabs → messages and composer
             ↑
       Tauri commands → Rust / Helix / settings
```

| Topic | Read when changing |
| --- | --- |
| [Runtime and state](docs/architecture/runtime.md) | Startup, IPC, state ownership, diagnostics |
| [Authentication](docs/architecture/authentication.md) | Accounts, permissions, token renewal |
| [Messaging](docs/architecture/messaging.md) | IRC history/reconnects, sending, EventSub, pins |
| [Listeners and notifications](docs/architecture/listeners.md) | Mentions, filters, unread, mute/ignore/block |
| [Windows and panes](docs/architecture/windows.md) | Tab ownership, transfers, native dragging, layout |
| [Emotes and assets](docs/architecture/assets.md) | Rendering, provider catalogs, badges, caches, completion |
| [Media and previews](docs/architecture/media.md) | Link fetching, inline playback, user cards |
| [Appearance and interaction](docs/architecture/appearance.md) | Preferences, themes, transparency, scrolling, zoom, controls |
| [Development](docs/development.md) | Setup, checks, isolated native verification, logs |
| [Releases](docs/releases.md) | Versioning, build workflow, signing, updates |

The [README](README.md) describes the app for users; [CHANGELOG.md](CHANGELOG.md) holds release
history. Topic pages describe invariants and source entrypoints rather than duplicating the code.
