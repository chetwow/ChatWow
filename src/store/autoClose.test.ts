import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";

const context = vi.hoisted(() => ({ label: "main" }));
vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
vi.mock("../lib/windows", async (original) => ({
  ...await original<typeof import("../lib/windows")>(),
  get WINDOW_LABEL() { return context.label; },
  get IS_MAIN_WINDOW() { return context.label === "main"; },
  ownsTab: (tab: Tab, label = context.label) => (tab.windowLabel ?? "main") === label,
  windowTabs: (tabs: Tab[], label = context.label) => tabs.filter(tab => (tab.windowLabel ?? "main") === label),
}));
import { panes, paneTabs, useChat } from "./chat";

const tab = (id: string, windowLabel = context.label): Tab => ({ id, windowLabel, kind: "channel", channel: id, account: "", avatarMode: "none", mention: null });
const close = vi.fn();
beforeEach(() => {
  context.label = "main";
  close.mockClear();
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  vi.stubGlobal("window", { close });
  useChat.setState(useChat.getInitialState(), true);
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic empty window and split closing", () => {
  it("defaults to closing child windows but retaining splits", () => {
    expect(useChat.getState().preferences.autoCloseEmptyChildWindows).toBe(true);
    expect(useChat.getState().preferences.autoCloseEmptySplits).toBe(false);
    useChat.setState({ tabs: [tab("one")] });
    useChat.getState().split(0, "right", "one");
    useChat.getState().requestCloseTab("one");
    expect(panes(useChat.getState())).toEqual([0, 1]);
    expect(close).not.toHaveBeenCalled();
  });
  it("removes only the just-emptied nested pane, retaining new empty panes and the final pane", () => {
    useChat.getState().updatePreferences({ autoCloseEmptySplits: true });
    useChat.setState({ tabs: [tab("one"), tab("two")] });
    useChat.getState().split(0, "right", "two");
    useChat.getState().split(1, "down");
    useChat.getState().requestCloseTab("two");
    expect(panes(useChat.getState())).toEqual([0, 2]);
    expect(paneTabs(useChat.getState(), 0).map(t => t.id)).toEqual(["one"]);
    expect(useChat.getState().focusedPane).toBe(2);
    useChat.getState().requestCloseTab("one");
    expect(panes(useChat.getState())).toEqual([2]);
    expect(close).not.toHaveBeenCalled();
  });
  it("keeps a pane with remaining tabs and never closes main's final pane", () => {
    useChat.getState().updatePreferences({ autoCloseEmptySplits: true });
    useChat.setState({ tabs: [tab("one"), tab("two")] });
    useChat.getState().requestCloseTab("one");
    expect(panes(useChat.getState())).toEqual([0]);
    useChat.getState().requestCloseTab("two");
    expect(panes(useChat.getState())).toEqual([0]);
    expect(close).not.toHaveBeenCalled();
  });
  it("closes a child only on its last tab close, ignoring tabs in other windows", () => {
    context.label = "chat-1";
    useChat.setState({ tabs: [tab("one"), tab("two"), tab("other", "main")] });
    useChat.getState().requestCloseTab("one");
    expect(close).not.toHaveBeenCalled();
    useChat.getState().requestCloseTab("two");
    expect(close).toHaveBeenCalledTimes(1);
    expect(useChat.getState().tabs.map(t => t.id)).toEqual(["other"]);
  });
  it("retains empty children when disabled or when already empty", () => {
    context.label = "chat-1";
    useChat.getState().updatePreferences({ autoCloseEmptyChildWindows: false });
    useChat.setState({ tabs: [tab("one")] });
    useChat.getState().requestCloseTab("one");
    useChat.getState().updatePreferences({ autoCloseEmptyChildWindows: true, autoCloseEmptySplits: true });
    useChat.getState().split(0, "right");
    useChat.getState().requestCloseTab("missing");
    expect(panes(useChat.getState())).toEqual([0, 1]);
    expect(close).not.toHaveBeenCalled();
  });
  it("waits for listener-close confirmation before closing an empty child", async () => {
    context.label = "chat-1";
    const listener: Tab = { ...tab("listener", "main"), kind: "mentions", channel: "", mention: {
      name: "Watcher", users: ["viewer"], channels: ["one"], accounts: [], phrases: [], notify: false,
    } };
    useChat.setState({ tabs: [tab("one"), listener] });
    useChat.getState().requestCloseTab("one");
    expect(useChat.getState().listenerCloseWarning?.listeners).toEqual(["Watcher"]);
    expect(close).not.toHaveBeenCalled();
    useChat.getState().cancelListenerClose();
    expect(useChat.getState().tabs).toHaveLength(2);
    useChat.getState().requestCloseTab("one");
    await useChat.getState().confirmListenerClose(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("leaves source panes and windows open when tabs move away", () => {
    context.label = "chat-1";
    useChat.getState().updatePreferences({ autoCloseEmptySplits: true });
    useChat.setState({ tabs: [tab("one")] });
    useChat.getState().split(0, "right", "one");
    expect(panes(useChat.getState())).toEqual([0, 1]);
    useChat.getState().receiveTabs([tab("one", "main")]);
    expect(panes(useChat.getState())).toEqual([0, 1]);
    expect(close).not.toHaveBeenCalled();
  });
});
