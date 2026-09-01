import { create } from "zustand";

type EmoteInfo = {
  name: string;
  urlLarge: string;
  provider: string;
};

type TooltipState = {
  emote: EmoteInfo | null;
  x: number;
  y: number;
  show: (emote: EmoteInfo, anchor: DOMRect) => void;
  hide: () => void;
};

/**
 * The tooltip renders fixed-position at the app root rather than inside the
 * message row, so the scroll container can't clip it.
 */
export const useTooltip = create<TooltipState>((set) => ({
  emote: null,
  x: 0,
  y: 0,
  show: (emote, anchor) =>
    set({ emote, x: anchor.left + anchor.width / 2, y: anchor.top }),
  hide: () => set({ emote: null }),
}));
