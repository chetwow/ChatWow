import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  CHAT_ZOOM_HIDE_MS, MAX_CHAT_ZOOM, MIN_CHAT_ZOOM,
  bindChatZoomEvents, nextChatZoom, type ChatZoomAction,
} from "../lib/chatZoom";
import { useChat } from "../store/chat";

export function ChatZoomControl({ viewport, capturesTyping }: {
  viewport: RefObject<HTMLDivElement | null>;
  capturesTyping: boolean;
}) {
  const zoom = useChat((state) => state.preferences.chatZoom);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const change = useCallback((action: ChatZoomAction) => {
    const state = useChat.getState();
    const chatZoom = nextChatZoom(state.preferences.chatZoom, action);
    if (chatZoom !== state.preferences.chatZoom) state.updatePreferences({ chatZoom });
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), CHAT_ZOOM_HIDE_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    return bindChatZoomEvents(element, capturesTyping, change);
  }, [viewport, capturesTyping, change]);

  const buttonClass = "grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-30";
  return (
    <div
      role="group"
      aria-label="Chat zoom"
      aria-hidden={!visible}
      inert={!visible}
      className={`chat-zoom-control absolute right-4 top-2 z-20 flex max-w-[calc(100%-24px)] flex-wrap items-center justify-end gap-0.5 rounded-3xl border border-line bg-surface-raised px-2 py-0.5 text-[12px] shadow-lg shadow-black/40 ${visible ? "" : "chat-zoom-hidden"}`}
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="mr-0.5 min-w-[4ch] text-center font-semibold tabular-nums text-ink">{zoom}%</span>
      <button type="button" aria-label="Zoom out chat" disabled={zoom <= MIN_CHAT_ZOOM} onClick={() => change(-1)} className={buttonClass}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8h10" strokeLinecap="round" /></svg>
      </button>
      <button type="button" aria-label="Zoom in chat" disabled={zoom >= MAX_CHAT_ZOOM} onClick={() => change(1)} className={buttonClass}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8h10M8 3v10" strokeLinecap="round" /></svg>
      </button>
      <span aria-hidden="true" className="mx-0.5 h-3 w-px shrink-0 bg-line" />
      <button type="button" aria-label="Reset chat zoom" onClick={() => change("reset")} className="h-6 cursor-pointer rounded-full px-1 text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">Reset</button>
    </div>
  );
}
