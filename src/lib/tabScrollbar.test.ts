import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTabScrollbar, TAB_SCROLLBAR_IDLE_MS, tabScrollbarGeometry } from "./tabScrollbar";

function element() {
  const captures = new Set<number>();
  const attributes = new Map<string, string>();
  return Object.assign(new EventTarget(), {
    hidden: false, dataset: {} as Record<string, string>, style: {} as Record<string, string>,
    attributes, clientWidth: 200, scrollWidth: 800, scrollLeft: 0,
    ownerDocument: { defaultView: new EventTarget() },
    getBoundingClientRect: () => ({ left: 10 }),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    setPointerCapture: (pointer: number) => captures.add(pointer),
    hasPointerCapture: (pointer: number) => captures.has(pointer),
    releasePointerCapture: (pointer: number) => captures.delete(pointer),
  });
}

function setup() {
  const row = element(), scroller = element(), track = element(), thumb = element();
  const binding = bindTabScrollbar(...[row, scroller, track, thumb].map((el) => el as unknown as HTMLElement) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]);
  const event = (target: EventTarget, type: string, props = {}) => target.dispatchEvent(
    Object.assign(new Event(type, { cancelable: true }), props),
  );
  const pointer = (type: string, clientX: number) => event(track, type, { pointerId: 1, button: 0, clientX });
  return { row, scroller, track, thumb, binding, event, pointer };
}

describe("tab scrollbar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fades with the pointer still over the row, and restarts the deadline on scrolling", () => {
    const { row, scroller, track, event, binding } = setup();
    event(row, "pointerenter");
    expect(track.dataset.visible).toBe("true");
    vi.advanceTimersByTime(TAB_SCROLLBAR_IDLE_MS);
    expect(track.dataset.visible).toBe("false");
    event(row, "pointermove");
    vi.advanceTimersByTime(800);
    event(scroller, "scroll");
    vi.advanceTimersByTime(800);
    expect(track.dataset.visible).toBe("true");
    vi.advanceTimersByTime(200);
    expect(track.dataset.visible).toBe("false");
    binding.dispose();
  });

  it("keeps a held drag visible, tracks outside the row, and hides after release or cancellation", () => {
    const { track, scroller, pointer, binding } = setup();
    pointer("pointerdown", 35); // Centre of the 50px thumb, with a 10px track offset.
    vi.advanceTimersByTime(5000);
    expect(track.dataset.visible).toBe("true");
    expect(track.hasPointerCapture(1)).toBe(true);
    pointer("pointermove", 110);
    expect(scroller.scrollLeft).toBe(300);
    pointer("pointermove", 1000);
    expect(scroller.scrollLeft).toBe(600);
    pointer("pointerup", 1000);
    expect(track.hasPointerCapture(1)).toBe(false);
    vi.advanceTimersByTime(TAB_SCROLLBAR_IDLE_MS);
    expect(track.dataset.visible).toBe("false");
    pointer("pointerdown", 185);
    pointer("pointercancel", 185);
    vi.advanceTimersByTime(TAB_SCROLLBAR_IDLE_MS);
    expect(track.hasPointerCapture(1)).toBe(false);
    expect(track.dataset.visible).toBe("false");
    binding.dispose();
  });

  it("supports track clicks and keyboard navigation without selecting tabs", () => {
    const { track, scroller, event, pointer, binding } = setup();
    expect(pointer("pointerdown", 110)).toBe(false); // Default prevented.
    expect(scroller.scrollLeft).toBe(300);
    pointer("pointerup", 110);
    event(track, "focus");
    vi.advanceTimersByTime(5000);
    expect(track.dataset.visible).toBe("true");
    event(track, "keydown", { key: "End" });
    expect(scroller.scrollLeft).toBe(600);
    event(track, "keydown", { key: "PageUp" });
    expect(scroller.scrollLeft).toBe(400);
    event(track, "keydown", { key: "ArrowLeft" });
    expect(scroller.scrollLeft).toBe(360);
    event(track, "keydown", { key: "Home" });
    expect(scroller.scrollLeft).toBe(0);
    expect(track.attributes.get("aria-valuenow")).toBe("0");
    event(track, "blur");
    vi.advanceTimersByTime(TAB_SCROLLBAR_IDLE_MS);
    expect(track.dataset.visible).toBe("false");
    binding.dispose();
  });

  it("recomputes the thumb on resize and removes it when the tabs fit", () => {
    const { scroller, track, thumb, binding } = setup();
    expect(thumb.style.width).toBe("50px");
    scroller.clientWidth = 400;
    binding.sync();
    expect(thumb.style.width).toBe("200px");
    scroller.scrollWidth = 300;
    binding.sync();
    expect(track.hidden).toBe(true);
    expect(track.dataset.visible).toBe("false");
    scroller.scrollWidth = 1000;
    binding.sync();
    expect(track.hidden).toBe(false);
    expect(thumb.style.width).toBe("160px");
    binding.dispose();
  });

  it("clears captured pointers and timers on window blur and removes listeners on unmount", () => {
    const { row, scroller, track, pointer, event, binding } = setup();
    pointer("pointerdown", 35);
    event(scroller.ownerDocument.defaultView, "blur");
    expect(track.hasPointerCapture(1)).toBe(false);
    expect(track.dataset.visible).toBe("false");
    event(row, "pointermove");
    binding.dispose();
    event(row, "pointermove");
    event(scroller, "scroll");
    expect(track.dataset.visible).toBe("false");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps elastic overscroll and handles empty or tiny panels", () => {
    expect(tabScrollbarGeometry(200, 800, -30).left).toBe(0);
    expect(tabScrollbarGeometry(200, 800, 900).left).toBe(150);
    expect(tabScrollbarGeometry(20, 800, 400)).toEqual({ maxScroll: 780, width: 20, travel: 0, left: 0 });
    expect(tabScrollbarGeometry(0, 0, 0)).toEqual({ maxScroll: 0, width: 0, travel: 0, left: 0 });
  });
});
