import type { PaneIndex, Preferences } from "../types";

export const MIN_CHAT_ZOOM = 50;
export const MAX_CHAT_ZOOM = 200;
export const CHAT_ZOOM_STEP = 10;
export const CHAT_ZOOM_HIDE_MS = 2_000;

export type ChatZoomAction = -1 | 1 | "reset";

export function paneChatZoom(preferences: Preferences, pane: PaneIndex): number {
  return preferences.zoomAllSplits
    ? preferences.chatZoom
    : preferences.paneChatZoom[pane] ?? preferences.chatZoom;
}

export function normalizePaneChatZoom(raw: unknown): Record<PaneIndex, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([id]) => Number.isSafeInteger(Number(id)) && Number(id) >= 0 && String(Number(id)) === id)
    .map(([id, zoom]) => [id, normalizeChatZoom(zoom)]));
}

export function normalizeChatZoom(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_CHAT_ZOOM, Math.max(MIN_CHAT_ZOOM, Math.round(value / CHAT_ZOOM_STEP) * CHAT_ZOOM_STEP))
    : 100;
}

export function nextChatZoom(current: number, action: ChatZoomAction): number {
  return action === "reset" ? 100 : normalizeChatZoom(current + action * CHAT_ZOOM_STEP);
}

export function chatZoomShortcut(event: Pick<KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
>): ChatZoomAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return null;
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") return 1;
  if (event.key === "-" || event.code === "NumpadSubtract") return -1;
  if (event.key === "0" || event.code === "Numpad0") return "reset";
  return null;
}

/** Accumulate small trackpad deltas; a wheel notch changes one step at most. */
export function chatZoomWheel() {
  let remainder = 0;
  let lastTime = 0;
  return (deltaY: number, deltaMode: number, now: number): -1 | 1 | null => {
    if (!Number.isFinite(deltaY) || deltaY === 0) return null;
    const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1);
    if (now - lastTime > 200 || Math.sign(delta) !== Math.sign(remainder)) remainder = 0;
    lastTime = now;
    remainder += delta;
    if (Math.abs(remainder) < 40) return null;
    const direction = remainder < 0 ? 1 : -1;
    remainder = 0;
    return direction;
  };
}

export function bindChatZoomEvents(
  viewport: HTMLElement,
  capturesTyping: boolean,
  change: (action: ChatZoomAction) => void,
): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = chatZoomShortcut(event);
    if (action === null) return;
    // Consume native page zoom even while a dialog owns the keyboard.
    event.preventDefault();
    if (!document.querySelector("[data-modal]")) change(action);
  };
  const step = chatZoomWheel();
  const onWheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    // React's wheel listeners are passive; native cancellation keeps the
    // webview from zooming the tabs and composer or scrolling the backlog.
    event.preventDefault();
    if (document.querySelector("[data-modal]")) return;
    const action = step(event.deltaY, event.deltaMode, event.timeStamp);
    if (action !== null) change(action);
  };
  if (capturesTyping) window.addEventListener("keydown", onKey, { capture: true });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    if (capturesTyping) window.removeEventListener("keydown", onKey, { capture: true });
    viewport.removeEventListener("wheel", onWheel);
  };
}
