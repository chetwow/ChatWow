# ChatWow

Start with the [architecture map](ARCHITECTURE.md), then read only the pages relevant to the change.
Keep implementation documentation in those topic pages; the README is for app users.

- IPC payloads are hand-mirrored between Rust and [src/types.ts](src/types.ts); update both sides together.
- Use the [development guide](docs/development.md) for commands and native verification. Browser mocks do not establish native window, drag, transparency, or packaged embed behavior.
- Follow the [release guide](docs/releases.md) for versioning, signing, and updater changes.
