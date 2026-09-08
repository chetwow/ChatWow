import { create } from "zustand";
import type { PaneIndex } from "../types";

/** Transient menu selection; changing it never changes the active chat. */
export const useSplitTarget = create<{
  pane: PaneIndex | null;
  select: (pane: PaneIndex | null) => void;
}>((set) => ({ pane: null, select: (pane) => set({ pane }) }));
