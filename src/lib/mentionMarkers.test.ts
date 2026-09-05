import { describe, expect, it } from "vitest";
import { markerUnderScrollbarThumb, mentionMarkerLayout } from "./mentionMarkers";

describe("mention marker layout", () => {
  it("maps rows near either end to the scrollbar extremes", () => {
    expect(mentionMarkerLayout(10, 20, 100, 500, 4)).toEqual({ scrollTop: 0, top: 0 });
    expect(mentionMarkerLayout(480, 20, 100, 500, 4)).toEqual({
      scrollTop: 400,
      top: 96,
    });
  });

  it("maps a middle row to the scroll position that centers it", () => {
    expect(mentionMarkerLayout(250, 20, 100, 500, 4)).toEqual({
      scrollTop: 210,
      top: 50,
    });
  });

  it("omits markers when the transcript does not scroll", () => {
    expect(mentionMarkerLayout(20, 20, 100, 100, 4)).toBeNull();
  });

  it("detects markers beneath the scrollbar thumb", () => {
    expect(markerUnderScrollbarThumb(5, 8, 0, 100, 500)).toBe(true);
    expect(markerUnderScrollbarThumb(50, 8, 0, 100, 500)).toBe(false);
    expect(markerUnderScrollbarThumb(92, 8, 400, 100, 500)).toBe(true);
  });
});
