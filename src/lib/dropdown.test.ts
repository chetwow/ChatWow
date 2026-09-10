import { describe, expect, it } from "vitest";
import { dropdownNavigationIndex } from "./dropdown";

describe("dropdown keyboard navigation", () => {
  it("wraps at both ends of the option list", () => {
    expect(dropdownNavigationIndex("ArrowDown", 3, 4)).toBe(0);
    expect(dropdownNavigationIndex("ArrowUp", 0, 4)).toBe(3);
  });
  it("moves one option at a time and supports Home and End", () => {
    expect(dropdownNavigationIndex("ArrowDown", 1, 4)).toBe(2);
    expect(dropdownNavigationIndex("ArrowUp", 2, 4)).toBe(1);
    expect(dropdownNavigationIndex("Home", 2, 4)).toBe(0);
    expect(dropdownNavigationIndex("End", 1, 4)).toBe(3);
  });
  it("keeps a one-option list in bounds", () => {
    expect(dropdownNavigationIndex("ArrowDown", 0, 1)).toBe(0);
    expect(dropdownNavigationIndex("ArrowUp", 0, 1)).toBe(0);
  });
});
