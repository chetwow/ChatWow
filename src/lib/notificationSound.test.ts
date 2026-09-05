import { describe, expect, it } from "vitest";
import { notificationSoundAllowed } from "./notificationSound";

const defaults = {
  muted: false,
  muteActiveTab: true,
  muteWhenWindowActive: false,
};

describe("notification sound muting", () => {
  it("preserves the old default for active and background tabs", () => {
    expect(notificationSoundAllowed(defaults, true, true)).toBe(false);
    expect(notificationSoundAllowed(defaults, true, false)).toBe(true);
    expect(notificationSoundAllowed(defaults, true, true, true)).toBe(true);
  });

  it("can allow ordinary sounds for the active tab", () => {
    expect(
      notificationSoundAllowed({ ...defaults, muteActiveTab: false }, true, true),
    ).toBe(true);
  });

  it("window muting silences every sound only while focused", () => {
    const preferences = { ...defaults, muteWhenWindowActive: true };
    expect(notificationSoundAllowed(preferences, true, false)).toBe(false);
    expect(notificationSoundAllowed(preferences, true, true, true)).toBe(false);
    expect(notificationSoundAllowed(preferences, false, false)).toBe(true);
  });

  it("the title-bar mute always wins", () => {
    expect(notificationSoundAllowed({ ...defaults, muted: true }, false, false, true)).toBe(false);
  });
});
