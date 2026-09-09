import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false }));
import { paneOf, paneTabs, useChat, windowSnapshot, hydrateWindowSnapshot } from "./chat";
import { windowTabs } from "../lib/windows";
import { isNewWindowShortcut } from "../lib/tabShortcuts";
import { useTabDrag } from "./tabDrag";
import { localNotice } from "../lib/notice";
import type { ChatMessage, Tab } from "../types";
const channel = (id: string, windowLabel = "main"): Tab => ({
  id, windowLabel, kind: "channel", channel: "room", account: "", avatarMode: "none", mention: null,
});

beforeEach(() => {
  useTabDrag.getState().end();
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  vi.stubGlobal("window", { close: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
});
afterEach(() => vi.unstubAllGlobals());

describe("window ownership", () => {
  it("drops a remote tab into the requested split and slot, preserving its retained state", async () => {
    useChat.setState({ tabs: [channel("a"), channel("remote", "chat-1"), channel("b")],
      active: { 0: "a" }, sentHistory: { remote: ["previous message"] } });
    useChat.getState().split(0, "right");
    useChat.getState().moveTab("b", 1, 0);
    await useChat.getState().dropTab({ tab: "remote", pane: 1, windowLabel: "chat-1" }, 1, 0);
    expect(paneTabs(useChat.getState(), 1).map(tab => tab.id)).toEqual(["remote", "b"]);
    expect(useChat.getState().tabs.find(tab => tab.id === "remote")?.windowLabel).toBe("main");
    expect(useChat.getState().active).toEqual({ 0: "a", 1: "remote" });
    expect(useChat.getState().sentHistory.remote).toEqual(["previous message"]);
    expect(useChat.getState().tabs).toHaveLength(3);
  });

  it("preserves legacy split membership when a tab leaves for another window", () => {
    const tabs = [channel("a"), channel("b"), channel("c")];
    useChat.setState({ tabs, preferences: { ...useChat.getState().preferences, splitLayout: "row", splitIndex: 2, paneLayout: null },
      active: { 0: "a", 1: "c" } });
    useChat.getState().receiveTabs(tabs.map(tab => tab.id === "a" ? { ...tab, windowLabel: "chat-1" } : tab));
    expect(paneTabs(useChat.getState(), 0).map(tab => tab.id)).toEqual(["b"]);
    expect(paneTabs(useChat.getState(), 1).map(tab => tab.id)).toEqual(["c"]);
    expect(useChat.getState().active).toEqual({ 0: "b", 1: "c" });
  });

  it("ignores stale drags after a tab was moved or closed", async () => {
    useChat.setState({ tabs: [channel("remote", "chat-2")] });
    await useChat.getState().dropTab({ tab: "remote", pane: 0, windowLabel: "chat-1" }, 0, 0);
    await useChat.getState().dropTab({ tab: "closed", pane: 0, windowLabel: "chat-1" }, 0, 0);
    expect(windowTabs(useChat.getState().tabs)).toEqual([]);
    expect(useChat.getState().tabs).toHaveLength(1);
  });

  it("restricts shortcut tab order and panes to this window while keeping other tabs during splits", () => {
    const tabs = [channel("a"), channel("remote", "chat-1"), channel("b")];
    useChat.setState({ tabs, active: { 0: "a" } });
    expect(windowTabs(tabs).map(t => t.id)).toEqual(["a", "b"]);
    expect(paneOf(useChat.getState(), "remote")).toBeNull();
    useChat.getState().split(0, "right");
    useChat.getState().moveTab("b", 1, 0);
    expect(paneTabs(useChat.getState(), 1).map(t => t.id)).toEqual(["b"]);
    expect(useChat.getState().tabs.find(t => t.id === "remote")?.windowLabel).toBe("chat-1");
  });

  it("moves ownership without deleting history, and settles the old active tab", () => {
    const tabs = [channel("a"), channel("b")];
    useChat.setState({ tabs, active: { 0: "a" }, sentHistory: { a: ["draft history"] } });
    useTabDrag.getState().start({ tab: "a", pane: 0, windowLabel: "main" });
    useChat.getState().receiveTabs([{ ...tabs[0], windowLabel: "chat-1" }, tabs[1]]);
    expect(useTabDrag.getState().drag).toBeNull();
    expect(useChat.getState().active[0]).toBe("b");
    expect(useChat.getState().sentHistory.a).toEqual(["draft history"]);
    const snapshot = windowSnapshot();
    useChat.setState({ sentHistory: {} });
    hydrateWindowSnapshot(snapshot);
    expect(useChat.getState().sentHistory.a).toEqual(["draft history"]);
    expect(typeof useChat.getState().newWindow).toBe("function");
  });

  it("hydrates another view of an already connected room without waiting for a new join", () => {
    const tab = channel("remote", "chat-1");
    useChat.setState({ tabs: [tab], ready: { remote: true }, roles: { remote: "moderator" } });
    useChat.getState().receiveTabs([tab, channel("local")]);
    expect(useChat.getState().ready.local).toBe(true);
    expect(useChat.getState().roles.local).toBe("moderator");
  });

  it("opens a user listener in a new right split with its existing live matches", async () => {
    const tab = channel("source");
    useChat.setState({ tabs: [tab], active: { 0: tab.id } });
    const message: ChatMessage = { ...localNotice(tab, ""), id: "live", kind: "chat", login: "viewer", displayName: "Viewer",
      ts: 1, segments: [{ kind: "text", text: "hello" }], systemMessage: null };
    useChat.getState().ingest([message]);
    await useChat.getState().openMentionsTab({ name: "Viewer", users: ["viewer"], channels: ["room"], accounts: [], phrases: [], notify: false },
      { destination: "split", seedCurrentMatches: true });
    const listener = useChat.getState().tabs.find(t => t.kind === "mentions")!;
    expect(paneOf(useChat.getState(), listener.id)).toBe(1);
    expect(useChat.getState().active).toEqual({ 0: "source", 1: listener.id });
    expect(useChat.getState().mentionLog[listener.id].map(m => m.id)).toEqual(["live"]);
    expect(listener.mention?.notify).toBe(false);
    useChat.getState().receiveTabs([{ ...tab, windowLabel: "chat-1" }, listener]);
    useChat.getState().ingest([{ ...message, id: "another-window" }]);
    expect(useChat.getState().mentionLog[listener.id].map(m => m.id)).toEqual(["live", "another-window"]);
  });

  it("carries a listener menu's position through tab creation into the new window", async () => {
    const newWindow = vi.fn(async () => {});
    useChat.setState({ tabs: [channel("source")], newWindow });
    const anchor = { x: 280, y: 415 };
    await useChat.getState().openMentionsTab({ name: "Viewer", users: ["viewer"], channels: ["room"], accounts: [], phrases: [], notify: false },
      { destination: "window", seedCurrentMatches: true, anchor });
    const listener = useChat.getState().tabs.find(tab => tab.kind === "mentions")!;
    expect(newWindow).toHaveBeenCalledWith(listener.id, anchor);
  });

  it("warns when closing an entire window removes a listener's remaining source", () => {
    const listener: Tab = { ...channel("listener", "chat-2"), kind: "mentions", channel: "", mention: {
      name: "Viewer", users: ["viewer"], channels: ["room"], accounts: [], phrases: [], notify: false,
    } };
    useChat.setState({ tabs: [channel("one"), channel("two"), listener] });
    useChat.getState().requestCloseWindow();
    expect(useChat.getState().listenerCloseWarning).toMatchObject({ closingWindow: true, listeners: ["Viewer"] });
    expect(window.close).not.toHaveBeenCalled();
  });

  it("recognizes Ctrl+N and Cmd+N only for the corresponding platform", () => {
    const key = { key: "n", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(isNewWindowShortcut(key, false)).toBe(true);
    expect(isNewWindowShortcut(key, true)).toBe(false);
    expect(isNewWindowShortcut({ ...key, ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isNewWindowShortcut({ ...key, shiftKey: true }, false)).toBe(false);
  });
});
