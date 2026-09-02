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
  | { kind: "page"; preview: LinkPreview; host: string }
  | { kind: "loading" };

/**
 * Where the preview hangs off: the middle of the hovered thing, and its top
 * and bottom edges. Both edges, because the preview sits above what you're
 * hovering where there's room for it and below where there isn't.
 */
export type Anchor = { x: number; top: number; bottom: number };

type TooltipState = {
  preview: Preview | null;
  anchor: Anchor;
  show: (preview: Preview, from: DOMRect) => void;
  hide: () => void;
};

/**
 * The preview renders fixed-position at the app root rather than inside the
 * message row, so the scroll container can't clip it.
 */
export const useTooltip = create<TooltipState>((set) => ({
  preview: null,
  anchor: { x: 0, top: 0, bottom: 0 },
  show: (preview, from) =>
    set({
      preview,
      anchor: { x: from.left + from.width / 2, top: from.top, bottom: from.bottom },
    }),
  hide: () => set({ preview: null }),
}));
