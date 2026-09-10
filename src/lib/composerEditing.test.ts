import { describe, expect, it, vi } from "vitest";
import { copyComposerSelection, replaceComposerSelection } from "./composerEditing";

describe("composer context editing", () => {
  it("appends at the end without replacing the word to the left", () => {
    expect(replaceComposerSelection({ value: "hello world", start: 11, end: 11 }, "!"))
      .toEqual({ value: "hello world!", caret: 12 });
  });
  it("keeps trailing whitespace when inserting at the caret", () => {
    expect(replaceComposerSelection({ value: "aaa ", start: 4, end: 4 }, "bbb"))
      .toEqual({ value: "aaa bbb", caret: 7 });
  });
  it("inserts inside a word without replacing either side of the caret", () => {
    expect(replaceComposerSelection({ value: "hello world", start: 8, end: 8 }, "X"))
      .toEqual({ value: "hello woXrld", caret: 9 });
  });
  it("replaces only the selected text and places the caret after pasted text", () => {
    expect(replaceComposerSelection({ value: "hello world!", start: 6, end: 11 }, "chat"))
      .toEqual({ value: "hello chat!", caret: 10 });
  });
  it("inserts at an unselected caret and strips line breaks like a single-line input", () => {
    expect(replaceComposerSelection({ value: "ab", start: 1, end: 1 }, "x\r\ny\nz"))
      .toEqual({ value: "axyzb", caret: 4 });
  });
  it("copies the exact selection, including emoji, before a cut can proceed", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const selection = { value: "a😀b", start: 1, end: 3 };
    expect(await copyComposerSelection(selection, write)).toBe(true);
    expect(write).toHaveBeenCalledWith("😀");
    expect(replaceComposerSelection(selection, "")).toEqual({ value: "ab", caret: 1 });
  });
  it("does not overwrite the clipboard for an empty selection", async () => {
    const write = vi.fn();
    expect(await copyComposerSelection({ value: "abc", start: 1, end: 1 }, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects failed copies so cut cannot remove the selection", async () => {
    const selection = { value: "keep this", start: 0, end: 9 };
    await expect(copyComposerSelection(selection, async () => { throw new Error("denied"); }))
      .rejects.toThrow("denied");
    expect(selection.value).toBe("keep this");
  });
});
