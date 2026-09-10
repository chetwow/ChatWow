import { create } from "zustand";
import type { SettingsTab } from "../components/SettingsDialog";

/** Dialog navigation is transient and local to this window. */
export const useSettings = create<{
  tab: SettingsTab | null;
  setTab: (tab: SettingsTab | null) => void;
}>((set) => ({
  tab: null,
  setTab: (tab) => set({ tab }),
}));

export const openAccountSettings = () => useSettings.getState().setTab("account");
