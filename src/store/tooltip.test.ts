import { beforeEach, describe, expect, it } from "vitest";

import { useTooltip } from "./tooltip";

const anchor = {
  left: 20,
  width: 40,
  top: 10,
  bottom: 30,
} as DOMRect;
const source = {} as HTMLElement;
const pointer = { x: 30, y: 20 };

beforeEach(() => {
  useTooltip.setState({
    preview: null,
    anchor: { x: 0, top: 0, bottom: 0 },
    generation: 0,
    holdUntilInput: false,
    heldSource: null,
    heldOrigin: null,
  });
});

describe("interaction-held previews", () => {
  it("ignores layout-synthesized hover changes until explicitly dismissed", () => {
    const held = useTooltip
      .getState()
      .show({ kind: "loading" }, anchor, { holdUntilInput: true, source, pointer });

    expect(held).toBe(1);
    expect(
      useTooltip
        .getState()
        .show({ kind: "message", line: "slid under the pointer" }, anchor),
    ).toBeNull();
    useTooltip.getState().hideTransient();
    expect(useTooltip.getState().preview).toEqual({ kind: "loading" });

    useTooltip.getState().hide();
    expect(useTooltip.getState().preview).toBeNull();
    expect(useTooltip.getState().generation).toBe(2);
  });

  it("allows an in-flight link preview to replace its own loading card", () => {
    const loading = useTooltip
      .getState()
      .show({ kind: "loading" }, anchor, { holdUntilInput: true, source, pointer });
    expect(loading).toBe(1);

    const resolved = useTooltip.getState().show(
      { kind: "image", url: "blob:preview" },
      anchor,
      { holdUntilInput: true, source, pointer, replaceGeneration: loading! },
    );

    expect(resolved).toBe(2);
    expect(useTooltip.getState().preview).toEqual({ kind: "image", url: "blob:preview" });
  });
});
