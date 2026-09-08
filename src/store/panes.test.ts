import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
import { getPaneLayout, paneIds, topRightPane } from "../lib/panes";
import { paneChatZoom } from "../lib/chatZoom";
import { DEFAULT_PREFERENCES, paneOf, panes, paneTabs, useChat } from "./chat";
import type { SplitDirection, Tab } from "../types";

const tabs: Tab[] = ["alpha", "bravo", "charlie", "delta"].map((id) => ({
  id, kind: "channel", channel: id, account: "", avatarMode: "none", mention: null,
}));
const contents = () => Object.fromEntries(panes(useChat.getState()).map((id) => [id, paneTabs(useChat.getState(), id).map((tab) => tab.id)]));

beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ tabs, active: { 0: "alpha" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("nested panels", () => {
  it("keeps zoom with the pane when switching and moving tabs", () => {
    useChat.getState().split(0, "right");
    useChat.getState().changeChatZoom(0, 1);
    useChat.getState().setActive("bravo", 0);
    expect(paneChatZoom(useChat.getState().preferences, 0)).toBe(110);
    useChat.getState().moveTab("bravo", 1, 0);
    expect(paneChatZoom(useChat.getState().preferences, 1)).toBe(100);
    expect(paneChatZoom(useChat.getState().preferences, 0)).toBe(110);
  });

  it("anchors shared zoom to the upper-right pane through nested splits and removals", () => {
    const corner = () => topRightPane(getPaneLayout(useChat.getState()).root);
    expect(corner()).toBe(0);
    useChat.getState().split(0, "right");
    expect(corner()).toBe(1);
    useChat.getState().split(1, "down");
    expect(corner()).toBe(1);
    useChat.getState().split(1, "up");
    expect(corner()).toBe(3);
    useChat.getState().split(0, "right");
    expect(corner()).toBe(3);
    useChat.getState().removePane(3);
    expect(corner()).toBe(1);
  });

  it.each(["left", "right", "up", "down"] as SplitDirection[])("splits %s repeatedly without moving existing tabs", (direction) => {
    useChat.getState().split(0, direction);
    useChat.getState().split(0, direction);
    expect(panes(useChat.getState())).toHaveLength(3);
    expect(contents()).toEqual({ 0: tabs.map((tab) => tab.id), 1: [], 2: [] });
    expect(useChat.getState().active).toEqual({ 0: "alpha", 1: null, 2: null });
    expect(useChat.getState().focusedPane).toBe(2);
    const root = getPaneLayout(useChat.getState()).root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") throw new Error("Expected split");
    expect(root.axis).toBe(direction === "left" || direction === "right" ? "row" : "column");
    expect(paneIds(root)).toEqual(direction === "left" || direction === "up" ? [1, 2, 0] : [0, 2, 1]);
  });

  it("imports legacy membership before a nested split or a tab close", async () => {
    useChat.setState({ preferences: { ...DEFAULT_PREFERENCES, splitLayout: "column", splitIndex: 2, splitRatio: 0.3 }, active: { 0: "bravo", 1: "delta" } });
    await useChat.getState().requestCloseTab("alpha");
    expect(contents()).toEqual({ 0: ["bravo"], 1: ["charlie", "delta"] });
    useChat.getState().split(1, "right");
    expect(contents()).toEqual({ 0: ["bravo"], 1: ["charlie", "delta"], 2: [] });
    expect(useChat.getState().active).toEqual({ 0: "bravo", 1: "delta", 2: null });
    expect(getPaneLayout(useChat.getState()).root).toMatchObject({ axis: "column", ratio: 0.3 });
  });

  it("moves, reorders, closes and reopens tabs across nested panels", async () => {
    useChat.getState().split(0, "right");
    useChat.getState().split(1, "down");
    useChat.getState().moveTab("bravo", 1, 0);
    useChat.getState().moveTab("delta", 2, 0);
    useChat.getState().moveTab("charlie", 2, 0);
    expect(contents()).toEqual({ 0: ["alpha"], 1: ["bravo"], 2: ["charlie", "delta"] });
    expect(useChat.getState().active).toEqual({ 0: "alpha", 1: "bravo", 2: "charlie" });
    await useChat.getState().requestCloseTab("charlie");
    expect(contents()[1]).toEqual(["bravo"]);
    expect(useChat.getState().active[2]).toBe("delta");
    await useChat.getState().reopenLastClosedTab();
    expect(contents()[2]).toEqual(["charlie", "delta"]);
    expect(useChat.getState().active[2]).toBe("charlie");
    useChat.getState().moveTab("charlie", 2, 1);
    expect(contents()[2]).toEqual(["delta", "charlie"]);
    expect(new Set(useChat.getState().tabs.map((tab) => tab.id)).size).toBe(4);
  });

  it("opens in the focused panel and preserves other visible tabs", async () => {
    useChat.getState().split(0, "left");
    useChat.getState().split(1, "down");
    await useChat.getState().openTab("channel", "newroom");
    const opened = useChat.getState().tabs.find((tab) => tab.channel === "newroom")!;
    expect(paneOf(useChat.getState(), opened.id)).toBe(2);
    expect(useChat.getState().active[2]).toBe(opened.id);
    useChat.getState().setActive("alpha");
    expect(useChat.getState().focusedPane).toBe(0);
    expect(useChat.getState().active[2]).toBe(opened.id);
  });

  it("removes only the selected panel and merges its tabs into its sibling", () => {
    useChat.getState().split(0, "right");
    useChat.getState().split(1, "down");
    useChat.getState().moveTab("bravo", 1, 0);
    useChat.getState().moveTab("charlie", 2, 0);
    useChat.getState().focusPane(1);
    useChat.getState().removePane(1);
    expect(contents()).toEqual({ 0: ["alpha", "delta"], 2: ["charlie", "bravo"] });
    expect(useChat.getState().focusedPane).toBe(2);
    expect(useChat.getState().active[2]).toBe("bravo");
    useChat.getState().removePane(0);
    expect(panes(useChat.getState())).toEqual([2]);
    useChat.getState().removePane(2);
    expect(panes(useChat.getState())).toEqual([2]);
    expect(useChat.getState().tabs).toHaveLength(4);
  });

  it("restores persisted structure, membership and independently resized dividers", () => {
    useChat.getState().split(0, "right");
    useChat.getState().split(1, "up");
    useChat.getState().moveTab("bravo", 2, 0);
    const root = getPaneLayout(useChat.getState()).root;
    if (root.kind !== "split" || root.second.kind !== "split") throw new Error("Expected nested split");
    useChat.getState().setSplitRatio(root.id, 0.6);
    useChat.getState().setSplitRatio(root.second.id, 0.25);
    const calls = vi.mocked(localStorage.setItem).mock.calls;
    const saved = JSON.parse(calls[calls.length - 1][1]);
    useChat.getState().updatePreferences(saved);
    expect(contents()).toEqual({ 0: ["alpha", "charlie", "delta"], 1: [], 2: ["bravo"] });
    expect(getPaneLayout(useChat.getState()).root).toMatchObject({ ratio: 0.6, second: { ratio: 0.25 } });
  });

  it("reopens into the focused panel when the original panel was removed", async () => {
    useChat.getState().split(0, "right");
    useChat.getState().moveTab("bravo", 1, 0);
    await useChat.getState().requestCloseTab("bravo");
    useChat.getState().removePane(1);
    useChat.getState().split(0, "down");
    useChat.getState().focusPane(0);
    await useChat.getState().reopenLastClosedTab();
    expect(paneOf(useChat.getState(), "bravo")).toBe(0);
    expect(useChat.getState().active[0]).toBe("bravo");
  });
});
