import { create } from "zustand";

/** One expanded player across panes, logs, and providers. Owners identify link instances,
 * not URLs: the same video can appear in several messages or panes. */
export const useInlineVideo = create<{
  owner: symbol | null;
  tabId: string | null;
  offscreen: boolean;
  setOffscreen: (owner: symbol, offscreen: boolean) => void;
  toggle: (owner: symbol, tabId?: string | null) => void;
  close: (owner: symbol) => void;
}>((set) => ({
  owner: null,
  tabId: null,
  offscreen: false,
  setOffscreen: (owner, offscreen) => set((state) =>
    state.owner === owner && state.offscreen !== offscreen ? { offscreen } : state),
  toggle: (owner, tabId = null) => set((state) => state.owner === owner
    ? { owner: null, tabId: null, offscreen: false } : { owner, tabId, offscreen: false }),
  // Cleanup from a replaced player must never close its successor.
  close: (owner) => set((state) => state.owner === owner ? { owner: null, tabId: null, offscreen: false } : state),
}));
