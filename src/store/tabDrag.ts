import { create } from "zustand";
import type { PaneIndex } from "../types";

/**
 * The tab currently being dragged, if any -- shared because a drag that
 * starts in one pane's tab bar has to be understood by the other's, and by
 * the empty-pane drop target between them. HTML5 drag data can't be read
 * until the drop, so the thing being dragged lives here instead of in the
 * `DataTransfer`, which only carries the payload for the drop itself.
 *
 * Its own store rather than a field on the chat store: nothing here is
 * persisted, and a value that changes on every dragenter has no business
 * waking the components subscribed to messages.
 */
export type TabDrag = { tab: string; pane: PaneIndex };

type DragState = {
  drag: TabDrag | null;
  start: (drag: TabDrag) => void;
  end: () => void;
};

export const useTabDrag = create<DragState>((set) => ({
  drag: null,
  start: (drag) => set({ drag }),
  end: () => set({ drag: null }),
}));
