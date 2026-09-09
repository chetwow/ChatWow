// Browser-only multiwindow fixtures; dynamically imported and absent from release output.
import { DEFAULT_PREFERENCES, hydrateWindowSnapshot, useChat, windowSnapshot } from "../store/chat";
import { WINDOW_LABEL, IS_MAIN_WINDOW, windowTabs, type WindowAnchor } from "../lib/windows";
import { randomMockMessage } from "./mockData";
import type { Preferences, Tab, ChatMessage } from "../types";

const KEY = "chatwow.window.";
const LOCAL = new Set(["paneLayout", "splitLayout", "splitIndex", "splitRatio", "paneChatZoom",
  "chatZoom", "zoomAllSplits", "muted", "alwaysOnTop"]);
let channel: BroadcastChannel | null = null;
let receiving = false;
const children: Window[] = [];

export function openMockWindow(tabId?: string, anchor?: WindowAnchor) {
  const label = `chat-${crypto.randomUUID()}`;
  const url = new URL(location.href);
  url.searchParams.set("window", label);
  // Open synchronously; popup blockers must leave the source tab intact.
  let master: Window = window;
  while (master.opener && !master.opener.closed) master = master.opener;
  const width = 420;
  const height = Math.max(320, Math.round(master.innerHeight * 0.75));
  const left = anchor ? window.screenX + anchor.x : master.screenX + (master.outerWidth - width) / 2;
  const top = anchor ? window.screenY + (window.outerHeight - window.innerHeight) + anchor.y
    : master.screenY + (master.outerHeight - height) / 2;
  const child = window.open("about:blank", label,
    `popup,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`);
  if (!child) throw new Error("The browser blocked the popup");
  const tabs = useChat.getState().tabs.map((tab) => tab.id === tabId ? { ...tab, windowLabel: label } : tab);
  const snapshot = { ...windowSnapshot(), tabs };
  localStorage.setItem(KEY + label, JSON.stringify({ data: snapshot, preferences: {
    ...useChat.getState().preferences, paneLayout: null, splitLayout: "none", paneChatZoom: {},
  } }));
  useChat.getState().receiveTabs(tabs);
  children.push(child);
  child.location.href = url.href;
}

export function restoreMockWindow(): boolean {
  if (IS_MAIN_WINDOW) return false;
  const raw = localStorage.getItem(KEY + WINDOW_LABEL);
  const saved = raw ? JSON.parse(raw) : null;
  if (saved) hydrateWindowSnapshot(saved.data);
  const preferences = saved?.preferences ?? DEFAULT_PREFERENCES;
  const first = windowTabs(useChat.getState().tabs)[0]?.id ?? null;
  useChat.setState({ preferences, active: { 0: first }, focusedPane: 0 });
  return true;
}

export function subscribeMockWindows() {
  channel = new BroadcastChannel("chatwow.mock-windows");
  channel.onmessage = ({ data }: MessageEvent<
    { tabs?: Tab[]; preferences?: Partial<Preferences>; messages?: ChatMessage[]; shutdown?: boolean }
  >) => {
    if (data.shutdown && !IS_MAIN_WINDOW) { window.close(); return; }
    receiving = true;
    try {
      if (data.tabs) useChat.getState().receiveTabs(data.tabs);
      if (data.preferences) useChat.setState({ preferences: { ...useChat.getState().preferences, ...data.preferences } });
      if (data.messages) useChat.getState().ingest(data.messages);
    } finally { receiving = false; }
  };
  const off = useChat.subscribe((state, before) => {
    if (receiving) return;
    if (JSON.stringify(state.tabs) !== JSON.stringify(before.tabs)) channel?.postMessage({ tabs: state.tabs });
    if (state.preferences !== before.preferences) {
      const preferences = Object.fromEntries(Object.entries(state.preferences).filter(([key, value]) =>
        !LOCAL.has(key) && JSON.stringify(value) !== JSON.stringify(before.preferences[key as keyof Preferences])));
      if (Object.keys(preferences).length) channel?.postMessage({ preferences });
    }
  });
  const timer = window.setInterval(() => {
    useChat.getState().expirePinnedMessages();
    if (!IS_MAIN_WINDOW) return;
    const tabs = useChat.getState().tabs.filter((tab) => tab.kind === "channel");
    if (!tabs.length) return;
    const messages = [randomMockMessage(tabs[Math.floor(Math.random() * tabs.length)])];
    useChat.getState().ingest(messages);
    channel?.postMessage({ messages });
  }, 1400);
  const unload = () => {
    if (IS_MAIN_WINDOW) {
      channel?.postMessage({ shutdown: true });
      for (const child of children) child.close();
    }
    if (!IS_MAIN_WINDOW) channel?.postMessage({ tabs: useChat.getState().tabs.filter((tab) =>
      (tab.windowLabel ?? "main") !== WINDOW_LABEL) });
  };
  window.addEventListener("beforeunload", unload);
  return () => {
    off();
    clearInterval(timer);
    window.removeEventListener("beforeunload", unload);
    channel?.close();
    channel = null;
  };
}
