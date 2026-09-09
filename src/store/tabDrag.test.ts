import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/windows", () => ({ WINDOW_LABEL: "main" }));
import { acceptsTabDrag, readTabDrag, useTabDrag, writeTabDrag } from "./tabDrag";

function transfer() {
  const values = new Map<string, string>();
  return {
    get types() { return [...values.keys()]; },
    effectAllowed: "uninitialized",
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
  } as unknown as DataTransfer;
}

afterEach(() => useTabDrag.getState().end());

describe("native tab drag payload", () => {
  it("accepts a drag in another window with no shared store and a protected payload", () => {
    const data = transfer();
    const dragged = { tab: "channel-tab", pane: 0, windowLabel: "chat-1" };
    writeTabDrag(data, dragged);
    const read = data.getData;
    data.getData = () => "";
    expect(useTabDrag.getState().drag).toBeNull();
    expect(acceptsTabDrag(data, 0)).toBe(true);
    data.getData = read;
    expect(readTabDrag(data)).toEqual(dragged);
    expect(data.effectAllowed).toBe("move");
  });

  it("rejects external text, malformed payloads and drops back onto the same pane body", () => {
    const data = transfer();
    data.setData("text/plain", "external text");
    expect(acceptsTabDrag(data)).toBe(false);
    expect(readTabDrag(data)).toBeNull();
    const drag = { tab: "a", pane: 0, windowLabel: "main" };
    writeTabDrag(data, drag);
    useTabDrag.getState().start(drag);
    expect(acceptsTabDrag(data, 0)).toBe(false);
    expect(acceptsTabDrag(data, 1)).toBe(true);
    data.getData = () => '{"tab":"a","pane":0}';
    expect(readTabDrag(data)).toBeNull();
  });
});
