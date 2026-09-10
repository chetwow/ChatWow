import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";
import { composerAutohideEnabled, scheduleComposerAutohide } from "../lib/composerAutohide";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
import { DEFAULT_PREFERENCES, useChat } from "./chat";

const channel = (id: string): Tab => ({ id, kind: "channel", channel: id, account: "", avatarMode: "none", mention: null });
beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ tabs: [channel("one"), channel("two")] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("composer autohide", () => {
  it("inherits the default-on rule independently of the panel's typing target", () => {
    expect(DEFAULT_PREFERENCES.autohideComposerInUnfocusedTabs).toBe(true);
    for (const override of [undefined, null]) {
      expect(composerAutohideEnabled(override, true)).toBe(true);
      expect(composerAutohideEnabled(override, false)).toBe(false);
    }
  });

  it("keeps explicit tab choices independent of both focus and global changes", async () => {
    await useChat.getState().setTabAutohideComposer("one", true);
    await useChat.getState().setTabAutohideComposer("two", false);
    for (const global of [true, false]) {
      useChat.getState().updatePreferences({ autohideComposerInUnfocusedTabs: global });
      const [one, two] = useChat.getState().tabs;
      expect(composerAutohideEnabled(one.autohideComposer, global)).toBe(true);
      expect(composerAutohideEnabled(two.autohideComposer, global)).toBe(false);
    }
  });

  it("preserves overrides when moving, closing and reopening a tab", async () => {
    await useChat.getState().setTabAutohideComposer("one", true);
    useChat.getState().split(0, "right", "one");
    expect(useChat.getState().tabs.find(tab => tab.id === "one")?.autohideComposer).toBe(true);
    useChat.getState().requestCloseTab("one");
    await useChat.getState().reopenLastClosedTab();
    expect(useChat.getState().tabs.find(tab => tab.id === "one")?.autohideComposer).toBe(true);
    expect(useChat.getState().tabs.find(tab => tab.id === "two")?.autohideComposer).toBeUndefined();
  });

  it("defaults to two seconds and persists bounded fractional delays", () => {
    expect(DEFAULT_PREFERENCES.composerAutohideDelaySeconds).toBe(2);
    for (const [requested, expected] of [[0.5, 0.5], [0, 0], [-1, 0], [30, 30], [30.5, 30], [60, 30], [NaN, 2]]) {
      useChat.getState().updatePreferences({ composerAutohideDelaySeconds: requested });
      expect(useChat.getState().preferences.composerAutohideDelaySeconds).toBe(expected);
      expect(JSON.parse(vi.mocked(localStorage.setItem).mock.lastCall![1]).composerAutohideDelaySeconds).toBe(expected);
    }
  });
});

describe("composer idle countdown", () => {
  const idle = { enabled: true, inputFocused: false, hovered: false, menuOpen: false, delaySeconds: 2 };

  it("hides only after the configured period without input focus", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    scheduleComposerAutohide(idle, hide);
    vi.advanceTimersByTime(1999);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it.each([{ inputFocused: true }, { hovered: true }, { menuOpen: true }, { enabled: false }])(
    "cancels pending hiding during interaction or when disabled: %j", (protectedState) => {
      vi.useFakeTimers();
      const hide = vi.fn();
      const cancel = scheduleComposerAutohide(idle, hide);
      vi.advanceTimersByTime(1500);
      cancel?.();
      scheduleComposerAutohide({ ...idle, ...protectedState }, hide);
      vi.advanceTimersByTime(5000);
      expect(hide).not.toHaveBeenCalled();
      scheduleComposerAutohide(idle, hide);
      vi.advanceTimersByTime(1999);
      expect(hide).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(hide).toHaveBeenCalledOnce();
    },
  );

  it("discards stale countdowns on delay changes and unmount", () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const cancelOld = scheduleComposerAutohide(idle, hide);
    vi.advanceTimersByTime(1000);
    cancelOld?.();
    const cancelNew = scheduleComposerAutohide({ ...idle, delaySeconds: 5 }, hide);
    vi.advanceTimersByTime(4999);
    expect(hide).not.toHaveBeenCalled();
    cancelNew?.();
    vi.advanceTimersByTime(5000);
    expect(hide).not.toHaveBeenCalled();
  });
});
