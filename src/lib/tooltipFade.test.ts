import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleTooltipFade, TOOLTIP_FADE_MS } from "./tooltipFade";

describe("tooltip fade lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("allows the transparent popup to paint before fading in", () => {
    const visible = vi.fn();
    scheduleTooltipFade(true, visible, vi.fn(), false);
    vi.advanceTimersByTime(16);
    expect(visible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(visible).toHaveBeenCalledWith(true);
  });

  it("retains content through the full fade out", () => {
    const visible = vi.fn();
    const remove = vi.fn();
    scheduleTooltipFade(false, visible, remove, false);
    expect(visible).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(TOOLTIP_FADE_MS - 1);
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("cancels stale removal when another tooltip opens", () => {
    const remove = vi.fn();
    const cancel = scheduleTooltipFade(false, vi.fn(), remove, false);
    vi.advanceTimersByTime(200);
    cancel();
    vi.runAllTimers();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([0, 16])("cancels entry during either animation frame (%i ms)", (elapsed) => {
    const visible = vi.fn();
    const cancel = scheduleTooltipFade(true, visible, vi.fn(), false);
    vi.advanceTimersByTime(elapsed);
    cancel();
    vi.runAllTimers();
    expect(visible).not.toHaveBeenCalled();
  });

  it("shows and removes immediately for reduced motion", () => {
    const visible = vi.fn();
    const remove = vi.fn();
    scheduleTooltipFade(true, visible, remove, true);
    expect(visible).toHaveBeenLastCalledWith(true);
    scheduleTooltipFade(false, visible, remove, true);
    expect(visible).toHaveBeenLastCalledWith(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
