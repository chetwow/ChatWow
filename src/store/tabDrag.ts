import { create } from "zustand";
import type { PaneIndex } from "../types";
import { WINDOW_LABEL } from "../lib/windows";

const TAB_TYPE = "application/x-chatwow-tab";

/**
 * The tab currently being dragged, if any -- shared because a drag that
 * starts in one pane's tab bar has to be understood by the other's, and by
 * the empty-pane drop target between them. HTML5 drag data can't be read
 * until the drop. Other windows recognize our MIME type during dragover
 * and read the identity from DataTransfer on drop; their stores are separate.
 *
 * Its own store rather than a field on the chat store: nothing here is
 * persisted, and a value that changes on every dragenter has no business
 * waking the components subscribed to messages.
 */
export type TabDrag = { tab: string; pane: PaneIndex; windowLabel: string };

export function writeTabDrag(data: DataTransfer, drag: TabDrag) {
  data.setData(TAB_TYPE, JSON.stringify(drag));
  data.effectAllowed = "move";
}

export function readTabDrag(data: DataTransfer): TabDrag | null {
  try {
    const drag = JSON.parse(data.getData(TAB_TYPE)) as Partial<TabDrag> | null;
    return drag && typeof drag.tab === "string" && drag.tab.length > 0 &&
      typeof drag.windowLabel === "string" && drag.windowLabel.length > 0 &&
      Number.isInteger(drag.pane) && Number(drag.pane) >= 0 ? drag as TabDrag : null;
  } catch { return null; }
}

/** types remains readable while the browser protects the payload during hover. */
export function acceptsTabDrag(data: DataTransfer | null, pane?: PaneIndex): boolean {
  const local = useTabDrag.getState().drag;
  if (local) return pane === undefined || local.windowLabel !== WINDOW_LABEL || local.pane !== pane;
  return !!data && Array.from(data.types).includes(TAB_TYPE);
}

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
