# Development

[Architecture map](../ARCHITECTURE.md)

Use Node LTS, stable Rust with rustfmt/Clippy, and the native Tauri build prerequisites for the
target platform. [release.yml](../.github/workflows/release.yml) records the Linux packages and
platform build matrix. Run commands below from the repository root.

```sh
npm ci --no-audit --prefer-offline --no-fund
npm run tauri dev
```

`npm run dev` serves the frontend at port 1420 with browser mock data when outside Tauri.
Mock imports are compiled out of production builds; `src/dev/mockWindows.ts` models ownership
and snapshots but does not exercise native bounds or windowing. `npm run build:local` builds
local installers without requiring updater artifacts/signing keys.

## Checks

| Purpose | Command |
| --- | --- |
| Frontend regression suite | `npm test` |
| Selected frontend regression | `npm test -- src/store/windows.test.ts` |
| Type-check and production bundle | `npm run build` |
| Rust unit suite | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Selected Rust module | `cargo test --manifest-path src-tauri/Cargo.toml --lib windows::tests` |
| Rust formatting | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` |
| Strict Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |

The release verification job additionally gates on npm and RustSec dependency audits before
packaging. Ignored Rust tests contact real services: use a test-name filter with `-- --ignored`
for provider/protocol work. They cover provider catalogs, badges, cards, previews, 7TV events,
anonymous IRC ping/pong, and public pins. The Twitch link check needs `TWITCH_TEST_CLIENT_ID`
and `TWITCH_TEST_TOKEN`; it skips without them. Offline fixtures cannot prove live API compatibility.

Regenerate the lazy emoji inventory with `python3 scripts/generate-emoji.py`; its Unicode names
come from the selected Python runtime. Version changes use the [release guide](releases.md).

## Native verification

Use an isolated profile for native UI changes so verification does not alter regular accounts
or tabs. Confirm port 1420 is free, start `npm run dev -- --host 127.0.0.1`, then in another terminal:

```sh
CHATWOW_LOG=debug npm run tauri dev -- --no-watch --config '{"identifier":"com.chatwow.drag-test","build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:1420"}}'
```

This identifier creates a separate persistent profile; it does not load browser mocks into native
windows. Verify the checkout and URL before reusing a running preview. Stop only test processes
started for the current verification. Record the actual native platforms and scenarios exercised.

For tab dragging, rebuild the native app and exercise detach/transfer back, correct vertical and
horizontal grab placement, no rejected-drop return animation, retained history, and no stale-source
error. Also check inside-window drops, Escape cancellation, an emptied source, display-edge
clamping, and mixed display scales when available. Browser popups and the macOS marker unit test
do not verify AppKit. Native drag diagnostics corroborate an observed gesture, not the full result.

For transparency, click/drag the slider, use arrows, Reset, Escape, and outside click. The popover
must stay open during adjustment/Reset. Only populated/empty chat backgrounds reveal the desktop;
text, media, and controls remain opaque. Check splits, themes, independent main/child values,
transfers, and restoration. Browser rendering cannot establish desktop transparency or WebKit's
range-input behavior.

For packaged inline-video changes, exercise the packaged localhost origin as well as development:
YouTube/Twitch provider restrictions differ from Vite and custom-scheme origins. Confirm opening,
closing, browser fallback, and owner cleanup across tabs/panes. Provider iframe load alone does
not prove successful playback.

## Reloads and diagnostics

Native development dynamically loads `src/dev/backendSession.ts` to serialize listener attachment,
bootstrap, and cleanup through StrictMode/HMR. A two-second metadata snapshot restores readiness,
roles, status, and completion after reload without reconnecting or refreshing accounts. Full
webview reload still loses its in-memory message log. Rust snapshot commands are debug-only;
frontend helpers remain behind compile-time development guards.

`CHATWOW_LOG=debug` increases application/webview detail while dependencies remain at warning level.
Logs rotate at 5 MB with three retained files. Settings → General can reveal the log directory:

- macOS: `~/Library/Logs/io.github.chetwow.chatwow/chatwow.log`
- Windows: `%LOCALAPPDATA%\io.github.chetwow.chatwow\logs\`
- Linux: `~/.local/share/io.github.chetwow.chatwow/logs/`

The isolated macOS profile logs under `~/Library/Logs/com.chatwow.drag-test/`. Inspect fresh
webview errors as well as native drag messages. [Runtime](architecture/runtime.md) defines
logging privacy and supervision requirements.
