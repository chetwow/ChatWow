# Appearance and interaction

[Architecture map](../../ARCHITECTURE.md)

Sources: [settings store](../../src/store/settings.ts), [themes.ts](../../src/lib/themes.ts),
[styles.css](../../src/styles.css), [ChatView.tsx](../../src/components/ChatView.tsx),
[Composer.tsx](../../src/components/Composer.tsx), [TabBar.tsx](../../src/components/TabBar.tsx).

## Preferences and backgrounds

Rust's `Preferences` and [types.ts](../../src/types.ts) define the IPC shape; the frontend store
normalizes values. Theme tokens are applied at the root. Opaque built-in chat colors stay below
the luminance assumption used by Rust's username-color contrast lift, so changing themes does
not require resolving messages again. Font size and GIF/Gigantify scales use independent root
custom properties; transcript font sizing must not alter tab measurement.

`windowOpacity` means chat background opacity, despite its historical name. The slider displays
`100 - windowOpacity` as transparency. Clamp/round to 0–100 and default non-finite values to 100.
This is a [local window preference](windows.md): all its tabs/panes share it, and transfers use
the destination value. New/legacy child windows start opaque.

Keep native/webview/root backgrounds clear and apply alpha only to `.chat-panel-background`,
never `opacity` on a subtree: text and media must remain opaque. Title bars, tabs, composers,
pins, dialogs, and dividers paint opaque surfaces. Both platform configs need transparent clear
backgrounds; common `macOSPrivateApi` must agree with Cargo's `macos-private-api` feature even
when building other platforms.

The transparency popover dismisses on outside pointer/focus, blur, or Escape. Do not dismiss
on a range input blur with null `relatedTarget`: macOS WebKit produces it during track clicks.
Refocus the slider after pointer release and before disabling Reset; Escape returns focus to
the trigger. Native verification is in the [development guide](../development.md#native-verification).

## Transcript scrolling, search, and zoom

Follow live traffic only while pinned to the bottom. Upward wheel intent unpins immediately,
including fractional gestures; returning within one pixel of bottom restores following.
Late layout/media changes and composer resizing preserve following. A queued resize correction
must recheck current pinning so it cannot override a reader who scrolled away.
"Jump to present" appears after three fully hidden newer visible rows; blocked rows do not count.

Find targets the active tab in the focused pane and searches retained resolved text only. It
excludes blocked rows and never makes a network request. Search navigation unpins; closing search
restores the live edge. Changing active target closes the prior session.

Zoom is 50–200% in 10% steps, persisted per pane with legacy `chatZoom` fallback. Enabling
`zoomAllSplits` adopts the focused pane's value and clears overrides. Zoom follows the pane,
not the tab. CSS zoom applies to the transcript only; keep the scroll container outside it so
search, markers, and popups use window pixels. Preserve the first visible message while browsing,
and live pinning otherwise. Media height limits divide by zoom; do not double-scale Twitch iframes.
Shared zoom has one control below the top-right pane's tabs, even in nested or empty layouts.

## Tabs and composer

Wrapped tabs measure widths and reserve add/close/unread/status slots. Hover/loading/avatar
changes must not change a tab's width. Avatars are out of flow; per-tab avatar mode is stamped
at creation, so new-tab preferences do not rewrite existing choices. Live tooltips are portal
overlays; optional thumbnails mount only when opened. Single-row mode skips wrap measurement;
the custom scrollbar is a sibling overlay, with pointer capture and keyboard navigation.

Keyboard tab order is the current window's subset of persisted order. Activating across panes
also focuses the new pane; shortcuts pause for modals. Context menus remain through chat scroll
but close on action, outside click, Escape, blur, or replacement.

Composer autohide is a per-tab override over the shared default, with a normalized 0–30 second
delay. Focus, hover, or an open menu cancels hiding and starts a fresh delay when lost. Keep the
input mounted to preserve drafts; hidden controls are inert, and typing clears inert synchronously
before focus so the first character is retained. Pickers/menus stay outside the animated clip.
Capture selection before secondary-click changes it. Native clipboard operations use the plugin;
Cut edits only after copying succeeds and Paste replaces the captured selection.
Sent-message history is per tab, session-only, capped at 100, and restores the pre-navigation
draft when stepping forward past its end. Picker arrows take precedence.

The split menu uses a transient selected-pane highlight independent of chat focus. Arrow keys
choose panes spatially; Tab enters actions. Pointer hover and keyboard focus must not highlight
different actions simultaneously. macOS cursor restoration runs after the keyboard event and
only while the window is focused.

## Shared controls

Text hints use `data-tooltip` with the root `TextTooltip`; iframe titles remain accessible names.
Portaled tooltips/dropdowns clamp to the viewport and escape dialog clipping. Escape dismisses
a dropdown before its enclosing dialog. Settings navigation is transient per window; the dialog
fits the 420px minimum width and stays below macOS traffic lights. Tooltip fade and message/composer
animations respect reduced motion. About uses the update snapshot's version and an ordinary
external repository link, without chat preview fetching.
