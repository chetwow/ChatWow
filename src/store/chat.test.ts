import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));

import { useChat } from "./chat";
import { paneChatZoom } from "../lib/chatZoom";

beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
});
afterEach(() => vi.unstubAllGlobals());

describe("chat zoom preferences", () => {
  const zoom = (pane: number) => paneChatZoom(useChat.getState().preferences, pane);

  it("zooms and resets only the working split by default, retaining the saved legacy scale", () => {
    useChat.getState().updatePreferences({ chatZoom: 120 });
    useChat.getState().split(0, "right");
    expect(useChat.getState().preferences.zoomAllSplits).toBe(false);
    useChat.getState().changeChatZoom(0, 1);
    expect([zoom(0), zoom(1)]).toEqual([130, 120]);
    useChat.getState().changeChatZoom(1, -1);
    expect([zoom(0), zoom(1)]).toEqual([130, 110]);
    expect(useChat.getState().focusedPane).toBe(1);
    useChat.getState().changeChatZoom(0, "reset");
    expect([zoom(0), zoom(1)]).toEqual([100, 110]);
    const saved = JSON.parse(vi.mocked(localStorage.setItem).mock.lastCall![1]);
    expect(saved.paneChatZoom).toEqual({ 0: 100, 1: 110 });
  });

  it("shares the focused scale when enabled and continues from it when disabled", () => {
    useChat.getState().split(0, "down");
    useChat.getState().changeChatZoom(1, -1);
    useChat.getState().changeChatZoom(0, 1);
    useChat.getState().updatePreferences({ zoomAllSplits: true });
    expect([zoom(0), zoom(1)]).toEqual([110, 110]);
    useChat.getState().changeChatZoom(1, 1);
    expect([zoom(0), zoom(1)]).toEqual([120, 120]);
    useChat.getState().updatePreferences({ zoomAllSplits: false });
    useChat.getState().changeChatZoom(0, -1);
    expect([zoom(0), zoom(1)]).toEqual([110, 120]);
    useChat.getState().updatePreferences({ zoomAllSplits: true });
    useChat.getState().changeChatZoom(0, "reset");
    expect([zoom(0), zoom(1)]).toEqual([100, 100]);
  });

  it("discards removed pane zoom and normalizes malformed saved overrides", () => {
    useChat.getState().split(0, "right");
    useChat.getState().changeChatZoom(1, 1);
    useChat.getState().removePane(1);
    useChat.getState().split(0, "down");
    expect(zoom(1)).toBe(100);
    useChat.getState().updatePreferences({
      zoomAllSplits: "true" as unknown as boolean,
      paneChatZoom: { 0: 999, 1: NaN, 3: 150, bad: 120 } as unknown as Record<number, number>,
    });
    expect(useChat.getState().preferences.zoomAllSplits).toBe(false);
    expect(useChat.getState().preferences.paneChatZoom).toEqual({ 0: 200, 1: 100 });
  });

  it("saves bounded transcript zoom independently of font and media preferences", () => {
    useChat.getState().updatePreferences({ chatFontSize: "large", gifScale: 2, chatZoom: 900 });
    expect(useChat.getState().preferences.chatZoom).toBe(200);
    useChat.getState().updatePreferences({ chatZoom: NaN });
    const preferences = useChat.getState().preferences;
    expect(preferences.chatZoom).toBe(100);
    expect(preferences.chatFontSize).toBe("large");
    expect(preferences.gifScale).toBe(2);
    const calls = vi.mocked(localStorage.setItem).mock.calls;
    expect(JSON.parse(calls[calls.length - 1][1]).chatZoom).toBe(100);
  });
});

describe("Power-up preferences", () => {
  it("defaults to animated effects and remembers static mode independently of the other switches", () => {
    expect(useChat.getState().preferences.disableMessageEffectAnimations).toBe(false);
    useChat.getState().updatePreferences({ disableMessageEffectAnimations: true });
    expect(useChat.getState().preferences.enableMessageEffects).toBe(true);
    expect(useChat.getState().preferences.enableGigantify).toBe(true);
    useChat.getState().updatePreferences({ enableMessageEffects: false, enableGigantify: false });
    useChat.getState().updatePreferences({ enableMessageEffects: true, enableGigantify: true });
    expect(useChat.getState().preferences.disableMessageEffectAnimations).toBe(true);
    const calls = vi.mocked(localStorage.setItem).mock.calls;
    expect(JSON.parse(calls[calls.length - 1][1]).disableMessageEffectAnimations).toBe(true);
  });

  it("defaults malformed animation preferences without changing existing disabled effects", () => {
    useChat.getState().updatePreferences({ enableMessageEffects: false, enableGigantify: false });
    useChat.getState().updatePreferences({ disableMessageEffectAnimations: "true" as unknown as boolean });
    expect(useChat.getState().preferences.disableMessageEffectAnimations).toBe(false);
    expect(useChat.getState().preferences.enableMessageEffects).toBe(false);
    expect(useChat.getState().preferences.enableGigantify).toBe(false);
  });
  it("toggles message effects independently of Gigantify and persists the setting", () => {
    expect(useChat.getState().preferences.enableMessageEffects).toBe(true);
    useChat.getState().updatePreferences({ enableMessageEffects: false });
    expect(useChat.getState().preferences.enableMessageEffects).toBe(false);
    expect(useChat.getState().preferences.enableGigantify).toBe(true);
    const calls = vi.mocked(localStorage.setItem).mock.calls;
    const saved = JSON.parse(calls[calls.length - 1][1]);
    expect(saved.enableMessageEffects).toBe(false);
  });

  it("defaults to enabled at 400% and preserves the scale when toggled", () => {
    expect(useChat.getState().preferences.enableGigantify).toBe(true);
    expect(useChat.getState().preferences.gigantifyScale).toBe(4);
    useChat.getState().updatePreferences({ enableGigantify: false, gigantifyScale: 5 });
    useChat.getState().updatePreferences({ enableGigantify: true });
    expect(useChat.getState().preferences.gigantifyScale).toBe(5);
  });

  it("clamps the scale to 100–500% and restores the default for invalid numbers", () => {
    for (const [input, expected] of [[0, 1], [6, 5], [3.5, 3.5], [NaN, 4], [Infinity, 4]]) {
      useChat.getState().updatePreferences({ gigantifyScale: input });
      expect(useChat.getState().preferences.gigantifyScale).toBe(expected);
    }
  });
});
