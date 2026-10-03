# Windows and panes

[Architecture map](../../ARCHITECTURE.md)

Sources: [windows.rs](../../src-tauri/src/windows.rs), [windows.ts](../../src/lib/windows.ts),
[panes.ts](../../src/lib/panes.ts), [Panes.tsx](../../src/components/Panes.tsx),
[tabDrag.ts](../../src/store/tabDrag.ts), [tab_drag_macos.rs](../../src-tauri/src/tab_drag_macos.rs).

## Identity, layout, and lifetime

Rust's `Settings::tabs` is the authoritative ordered list across windows. Each tab has a stable
ID and `window_label`; each webview renders only its owned tabs. Account connections and room
assets are shared. Listeners can collect from source tabs in another window.

Pane layout is a binary tree of axis/ratio split nodes and stable numeric leaf IDs, with a
tab-ID-to-pane-ID map. Rust persists this frontend-owned value; frontend helpers validate it,
ignore stale assignments, and import legacy split fields on the first edit. Membership never
creates or duplicates tabs. Local reorder requests affect only the caller's tabs.
`commitTabs` updates membership and visual order together. Removing a pane merges its tabs into
its sibling subtree while preserving other dividers. Divider ratios persist on release/cancel,
not on every pointer move.

`active` selects the visible tab in every pane; `focusedPane` owns new tabs, find, close, and
typing capture. A different mounted composer must not steal focus. If the focused pane is empty,
a visible composer can take capture. Modals and menus retain keyboard control. Reopening a closed
tab restores its previous pane when possible, otherwise the focused one; the undo record lasts
only for the session. Removed account IDs are sanitized through the validated backend open path.

Automatic closure runs only after an explicit tab close. Empty-split closure defaults off;
empty-child-window closure defaults on. Neither closes the last pane, main window, newly created
empty panes/windows, or windows emptied by moving tabs.

Closing main quits the app. Explicitly closing a child closes its tabs, applies listener-source
warnings, and removes that child from the saved session. Other children, including empty ones,
restore next launch. IDs are never reused. Native bounds use window-state's size, position, and
maximization flags only; restoring visibility or decorations would conflict with startup/config.

Local preferences include pane layout, zoom, pin, mute, and `windowOpacity`; shared appearance
and account changes reach all windows. Keep Rust's `LOCAL_PREFERENCES` and the browser mock's
`LOCAL` set aligned. Main and child overrides persist separately. New children copy main's pin
but start with opaque chat backgrounds; legacy children without pin values are unpinned.

## Event replay and transfer

The backend wraps relevant events in a sequenced `window://event` journal. A source supplies its
retained frontend data plus last applied sequence. The destination subscribes before claiming
the snapshot, replays the intervening events, then releases newly queued events. This preserves
messages and moderation through transfers without reconnecting. Journal retention is bounded
outside pending transfers; stale cursors fail visibly. Restored windows also retain early startup
events until their listeners attach.

Tab-changing command responses must not overwrite a newer tab event. Reconcile pending local
placement against the latest received tabs regardless of response/event order, so stale results
cannot resurrect removed tabs or reclaim transferred tabs.

Cross-window drops carry tab ID and source window in the custom drag MIME payload. The backend
validates current ownership before moving the tab, and the destination places/activates it in
the target pane. Consume the source drag once. A tab already moved by the destination must make
the source's later `dragend` a silent no-op.

An unhandled release outside all visible, non-minimized app frames detaches through the same
snapshot/ownership path. Recheck ownership after creating the child. Never infer outside drop
from `dropEffect`: WebKit may report `copy` for an unhandled release. Preserve the CSS grab offset,
convert using the destination display scale, and clamp the new outer frame to that display's
work area. Moving the final tab leaves its original window open.

macOS recognizes only ChatWow-marked AppKit drag sessions. Both modern and legacy drag entrypoints
disable rejected-drop return animation for these sessions. Use the physical cursor captured by
native completion, or native cursor at `dragend` on older paths, rather than WebKit's end
coordinates. Accepted native drops and Escape cancellation are no-ops. Unit tests and browser
mocks cannot validate AppKit behavior; use [native verification](../development.md#native-verification).

## Native presentation and packaged origin

Main and child windows share the merged platform config. macOS replaces the entire base
`app.windows` array, so shared window settings must be updated in both
[base](../../src-tauri/tauri.conf.json) and [macOS](../../src-tauri/tauri.macos.conf.json) configs.
Both disable native `dragDropEnabled` so HTML tab dragging reaches the webview. macOS retains
system decorations with an overlay title bar; other platforms draw their own window controls.
The macOS menu avoids the native Close Window binding so Cmd+W reaches tab-close handling.

New windows use minimum width and 75% of main's content height, bounded by the minimum height.
Menu-created windows anchor below the selected action, keyboard-created windows center over main,
and detached tabs align their grab point with release. Apply placement before showing the child.

[local_assets.rs](../../src-tauri/src/local_assets.rs) gives packaged webviews an ephemeral
`http://localhost:<port>/` origin for YouTube referrers and Twitch frame-ancestor checks.
Bind and retain one IPv4 loopback listener; serve only compiled in-memory assets with exact Host,
same-origin Origin when supplied, and GET/HEAD checks. There are no filesystem lookups, HTTP
commands, credentials, CORS access, or SPA fallback. `frame-ancestors 'none'` blocks framing.
Set that exact process-local Tauri frontend origin before constructing any window; no remote
capability grants are needed. Development continues to use Vite.
