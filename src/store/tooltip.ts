import { create } from "zustand";

import type { LinkPreview } from "../types";

/**
 * What the hover preview is showing: the big version of an emote, the image
 * behind a link, what the page behind a link says about itself, or the spinner
 * that stands in while either of the last two is on its way.
 *
 * One store for all of them, so hovering a link while an emote's preview is up
 * replaces it. Two would leave both on screen, overlapping.
 */
export type Preview =
  /**
   * `by` is only known for an emote reached through a *link*, which is
   * resolved from the 7TV API. An emote in a message carries no owner -- it
   * was resolved from an emote set, which doesn't say who made it.
   */
  | { kind: "emote"; name: string; urlLarge: string; provider: string; by?: string }
  | { kind: "image"; url: string }
  | { kind: "gif"; url: string; alt: string }
  | { kind: "message"; line: string }
  | { kind: "page"; preview: LinkPreview; host: string }
  | { kind: "loading" };

/**
 * Where the preview hangs off: the middle of the hovered thing, and its top
 * and bottom edges. Both edges, because the preview sits above what you're
 * hovering where there's room for it and below where there isn't.
 */
export type Anchor = { x: number; top: number; bottom: number };
export type PointerPosition = { x: number; y: number };

type ShowOptions =
  | { holdUntilInput?: false }
  | {
      holdUntilInput: true;
      source: HTMLElement;
      pointer: PointerPosition;
      replaceGeneration?: number;
    };

type TooltipState = {
  preview: Preview | null;
  anchor: Anchor;
  /**
   * Changes whenever one preview replaces or dismisses another. Callers doing
   * asynchronous work can use the value returned by `show` to avoid reviving
   * a preview that the user has already dismissed.
   */
  generation: number;
  holdUntilInput: boolean;
  heldSource: HTMLElement | null;
  heldOrigin: PointerPosition | null;
  show: (preview: Preview, from: DOMRect, options?: ShowOptions) => number | null;
  /** Hide regardless of whether a link preview is being held. */
  hide: () => void;
  /** Hide an ordinary hover, but leave an interaction-held link preview alone. */
  hideTransient: () => void;
};

/**
 * The preview renders fixed-position at the app root rather than inside the
 * message row, so the scroll container can't clip it.
 */
export const useTooltip = create<TooltipState>((set, get) => ({
  preview: null,
  anchor: { x: 0, top: 0, bottom: 0 },
  generation: 0,
  holdUntilInput: false,
  heldSource: null,
  heldOrigin: null,
  show: (preview, from, options) => {
    const current = get();
    // Chat reflow can synthesize mouseenter on an emote or marker that slides
    // beneath a stationary pointer. Do not let that replace a held link card.
    // The link resolver may replace its own loading card by presenting the
    // generation that loading card received.
    if (
      current.holdUntilInput &&
      (options?.holdUntilInput !== true ||
        options.replaceGeneration !== current.generation)
    ) {
      return null;
    }
    const generation = current.generation + 1;
    set({
      preview,
      anchor: { x: from.left + from.width / 2, top: from.top, bottom: from.bottom },
      generation,
      holdUntilInput: options?.holdUntilInput ?? false,
      heldSource: options?.holdUntilInput ? options.source : null,
      heldOrigin: options?.holdUntilInput ? options.pointer : null,
    });
    return generation;
  },
  hide: () =>
    set((state) => ({
      preview: null,
      generation: state.generation + 1,
      holdUntilInput: false,
      heldSource: null,
      heldOrigin: null,
    })),
  hideTransient: () =>
    set((state) =>
      state.holdUntilInput
        ? state
        : {
            preview: null,
            generation: state.generation + 1,
            holdUntilInput: false,
            heldSource: null,
            heldOrigin: null,
          },
    ),
}));
