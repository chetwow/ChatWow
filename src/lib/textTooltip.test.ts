import { describe, expect, it } from "vitest";
import { textTooltipDelay, textTooltipPosition } from "./textTooltip";

describe("text tooltip placement", () => {
  it("places a title-bar hint below its control", () => {
    expect(textTooltipPosition({ left: 100, right: 120, top: 0, bottom: 32 }, 100, 30, 800, 600))
      .toEqual({ left: 60, top: 37 });
  });
  it("flips a composer hint above the bottom edge", () => {
    expect(textTooltipPosition({ left: 100, right: 120, top: 560, bottom: 590 }, 100, 40, 800, 600))
      .toEqual({ left: 60, top: 515 });
  });
  it("keeps hints inside the left and right edges", () => {
    expect(textTooltipPosition({ left: 0, right: 20, top: 100, bottom: 120 }, 260, 30, 420, 320).left).toBe(8);
    expect(textTooltipPosition({ left: 400, right: 420, top: 100, bottom: 120 }, 260, 30, 420, 320).left).toBe(152);
  });
  it("clamps tall hints in short windows", () => {
    expect(textTooltipPosition({ left: 0, right: 20, top: 10, bottom: 30 }, 200, 304, 420, 320).top).toBe(8);
  });
});

describe("text tooltip hover delays", () => {
  it("uses the title bar override and retains the standard delay elsewhere", () => {
    expect(textTooltipDelay("800")).toBe(800);
    expect(textTooltipDelay()).toBe(400);
  });
  it("accepts zero delay and rejects invalid overrides", () => {
    expect(textTooltipDelay("0")).toBe(0);
    for (const value of ["", " ", "-1", "invalid", "Infinity"]) {
      expect(textTooltipDelay(value)).toBe(400);
    }
  });
});
