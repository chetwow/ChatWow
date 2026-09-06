import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));

import { DEFAULT_PREFERENCES, useChat } from "./chat";

beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState({ preferences: { ...DEFAULT_PREFERENCES } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Gigantify preferences", () => {
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
