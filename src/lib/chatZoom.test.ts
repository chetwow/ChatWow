import { afterEach, describe, expect, it, vi } from "vitest";
import { bindChatZoomEvents, chatZoomShortcut, chatZoomWheel, nextChatZoom, normalizeChatZoom } from "./chatZoom";

afterEach(() => vi.unstubAllGlobals());

const key = (key: string, extra = {}) => ({
  key, code: "", ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...extra,
});

describe("chat zoom shortcuts", () => {
  it("accepts either primary modifier, the unshifted equals key, and numpad keys", () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const name of ["+", "="]) expect(chatZoomShortcut(key(name, modifier))).toBe(1);
      expect(chatZoomShortcut(key("-", modifier))).toBe(-1);
      expect(chatZoomShortcut(key("0", modifier))).toBe("reset");
      expect(chatZoomShortcut(key("Unidentified", { ...modifier, code: "NumpadAdd" }))).toBe(1);
      expect(chatZoomShortcut(key("Unidentified", { ...modifier, code: "NumpadSubtract" }))).toBe(-1);
      expect(chatZoomShortcut(key("Insert", { ...modifier, code: "Numpad0" }))).toBe("reset");
    }
  });

  it("leaves ordinary typing, Alt shortcuts and composition alone", () => {
    expect(chatZoomShortcut(key("+"))).toBeNull();
    expect(chatZoomShortcut(key("-", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(chatZoomShortcut(key("=", { metaKey: true, isComposing: true }))).toBeNull();
    expect(chatZoomShortcut(key("f", { ctrlKey: true }))).toBeNull();
  });
});

describe("chat zoom bounds", () => {
  it("clamps repeated actions and can reset from either bound", () => {
    let zoom = 100;
    for (let i = 0; i < 30; i++) zoom = nextChatZoom(zoom, 1);
    expect(zoom).toBe(200);
    expect(nextChatZoom(zoom, "reset")).toBe(100);
    for (let i = 0; i < 30; i++) zoom = nextChatZoom(zoom, -1);
    expect(zoom).toBe(50);
    expect(nextChatZoom(zoom, "reset")).toBe(100);
  });

  it("normalizes saved values to supported steps and defaults invalid numbers", () => {
    for (const [input, expected] of [[0, 50], [900, 200], [123, 120], [NaN, 100], [Infinity, 100]]) {
      expect(normalizeChatZoom(input)).toBe(expected);
    }
    expect(normalizeChatZoom(undefined as unknown as number)).toBe(100);
  });
});

describe("chat wheel zoom", () => {
  it("supports pixel, line and page wheels without jumping multiple steps per event", () => {
    const step = chatZoomWheel();
    expect(step(-100, 0, 1)).toBe(1);
    expect(step(3, 1, 2)).toBe(-1);
    expect(step(-1, 2, 3)).toBe(1);
    expect(step(800, 0, 4)).toBe(-1);
  });

  it("accumulates trackpad motion and discards a partial gesture after a pause or reversal", () => {
    const step = chatZoomWheel();
    expect(step(-20, 0, 1)).toBeNull();
    expect(step(-20, 0, 2)).toBe(1);
    expect(step(-30, 0, 3)).toBeNull();
    expect(step(20, 0, 4)).toBeNull();
    expect(step(20, 0, 5)).toBe(-1);
    expect(step(30, 0, 6)).toBeNull();
    expect(step(20, 0, 500)).toBeNull();
    expect(step(20, 0, 501)).toBe(-1);
    expect(step(0, 0, 502)).toBeNull();
    expect(step(NaN, 0, 503)).toBeNull();
  });
});

describe("chat zoom input ownership", () => {
  const event = (type: string, fields: object) => Object.assign(new Event(type, { cancelable: true }), fields);
  const wheel = (extra = {}) => event("wheel", { deltaY: -100, deltaMode: 0, ctrlKey: true, ...extra });

  it("cancels native zoom, owns only the focused pane's keyboard, and leaves ordinary scrolling alone", () => {
    const keyboard = new EventTarget();
    vi.stubGlobal("window", keyboard);
    vi.stubGlobal("document", { querySelector: () => null });
    const focused = new EventTarget() as HTMLElement;
    const other = new EventTarget() as HTMLElement;
    const changed = vi.fn();
    const otherChanged = vi.fn();
    const listen = vi.spyOn(focused, "addEventListener");
    const off = bindChatZoomEvents(focused, true, changed);
    const otherOff = bindChatZoomEvents(other, false, otherChanged);
    expect(listen).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });
    const shortcut = event("keydown", key("=", { metaKey: true }));
    keyboard.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith(1);
    expect(otherChanged).not.toHaveBeenCalled();
    const scrolling = wheel({ ctrlKey: false });
    focused.dispatchEvent(scrolling);
    expect(scrolling.defaultPrevented).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const zooming = wheel({ ctrlKey: false, metaKey: true });
    other.dispatchEvent(zooming);
    expect(zooming.defaultPrevented).toBe(true);
    expect(otherChanged).toHaveBeenCalledExactlyOnceWith(1);
    off();
    otherOff();
    const removed = wheel();
    focused.dispatchEvent(removed);
    keyboard.dispatchEvent(event("keydown", key("-", { ctrlKey: true })));
    expect(removed.defaultPrevented).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not scale chat behind a modal or leak the shortcut into browser zoom", () => {
    const keyboard = new EventTarget();
    vi.stubGlobal("window", keyboard);
    vi.stubGlobal("document", { querySelector: () => ({}) });
    const viewport = new EventTarget() as HTMLElement;
    const changed = vi.fn();
    const off = bindChatZoomEvents(viewport, true, changed);
    const shortcut = event("keydown", key("-", { ctrlKey: true }));
    const zooming = wheel();
    keyboard.dispatchEvent(shortcut);
    viewport.dispatchEvent(zooming);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(zooming.defaultPrevented).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    off();
  });
});
