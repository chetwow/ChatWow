import { describe, expect, it } from "vitest";
import { adjacentPane, normalizePaneLayout } from "./panes";

const rects = [
  { id: 0, left: 0, top: 0, right: 500, bottom: 800 },
  { id: 1, left: 505, top: 0, right: 1000, bottom: 395 },
  { id: 2, left: 505, top: 400, right: 1000, bottom: 800 },
];

describe("spatial panel selection", () => {
  it("moves in all four directions through an uneven nested layout", () => {
    expect(adjacentPane(rects, 0, "right")).toBe(2);
    expect(adjacentPane(rects, 2, "up")).toBe(1);
    expect(adjacentPane(rects, 1, "down")).toBe(2);
    expect(adjacentPane(rects, 2, "left")).toBe(0);
    expect(adjacentPane(rects, 0, "left")).toBe(0);
    expect(adjacentPane(rects, 1, "up")).toBe(1);
  });
});

describe("saved panel validation", () => {
  it("rejects repeated identities and drops stale assignments", () => {
    expect(normalizePaneLayout({ root: { kind: "split", id: "s", axis: "row", first: { kind: "pane", id: 0 }, second: { kind: "pane", id: 0 } } })).toBeNull();
    expect(normalizePaneLayout({ root: { kind: "pane", id: 4 }, tabPanes: { valid: 4, stale: 1, malformed: "4" } })).toEqual({ root: { kind: "pane", id: 4 }, tabPanes: { valid: 4 } });
  });
});
