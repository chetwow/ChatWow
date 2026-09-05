import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import {
  isMacSettingsShortcut,
  isReopenClosedTabShortcut,
  tabForShortcut,
  tabShortcut,
} from "./tabShortcuts";

const key = (
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {},
) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

const tabs = ["a", "b", "c"].map(
  (id): Tab => ({
    id,
    kind: "channel",
    channel: id,
    account: "",
    avatarMode: "none",
    mention: null,
  }),
);

describe("tab shortcuts", () => {
  it("recognizes Settings only as plain Cmd-comma on macOS", () => {
    expect(isMacSettingsShortcut(key(",", { metaKey: true }), true)).toBe(true);
    expect(isMacSettingsShortcut(key(",", { ctrlKey: true }), false)).toBe(false);
    expect(isMacSettingsShortcut(key(",", { metaKey: true, shiftKey: true }), true)).toBe(false);
  });

  it("recognizes the platform's Chrome-style reopen shortcut", () => {
    expect(isReopenClosedTabShortcut(key("t", { ctrlKey: true, shiftKey: true }), false)).toBe(
      true,
    );
    expect(isReopenClosedTabShortcut(key("T", { metaKey: true, shiftKey: true }), true)).toBe(
      true,
    );
    expect(isReopenClosedTabShortcut(key("t", { ctrlKey: true }), false)).toBe(false);
  });

  it("uses Ctrl-number off macOS and Cmd-number on macOS", () => {
    expect(tabShortcut(key("3", { ctrlKey: true }), false)).toEqual({
      kind: "position",
      index: 2,
    });
    expect(tabShortcut(key("9", { metaKey: true }), true)).toEqual({ kind: "last" });
    expect(tabShortcut(key("3", { metaKey: true }), false)).toBeNull();
    expect(tabShortcut(key("3", { ctrlKey: true }), true)).toBeNull();
  });

  it("cycles with Ctrl-Tab on Windows/Linux", () => {
    expect(tabShortcut(key("Tab", { ctrlKey: true }), false)).toEqual({
      kind: "cycle",
      direction: 1,
    });
    expect(tabShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "cycle",
      direction: -1,
    });
  });

  it("cycles with Cmd-Option-arrow on macOS", () => {
    expect(tabShortcut(key("ArrowLeft", { metaKey: true, altKey: true }), true)).toEqual({
      kind: "cycle",
      direction: -1,
    });
    expect(tabShortcut(key("ArrowRight", { metaKey: true, altKey: true }), true)).toEqual({
      kind: "cycle",
      direction: 1,
    });
  });

  it("jumps by global position and cycles around either end", () => {
    expect(tabForShortcut(tabs, "a", { kind: "position", index: 1 })?.id).toBe("b");
    expect(tabForShortcut(tabs, "a", { kind: "last" })?.id).toBe("c");
    expect(tabForShortcut(tabs, "c", { kind: "cycle", direction: 1 })?.id).toBe("a");
    expect(tabForShortcut(tabs, "a", { kind: "cycle", direction: -1 })?.id).toBe("c");
    expect(tabForShortcut(tabs, "a", { kind: "position", index: 7 })).toBeNull();
  });
});
