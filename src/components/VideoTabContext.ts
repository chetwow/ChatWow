import { createContext } from "react";

/** Both visible split panes are active; retained background tabs are not. */
export const VideoTabContext = createContext<{ tabId: string | null; active: boolean }>({
  tabId: null,
  active: true,
});
