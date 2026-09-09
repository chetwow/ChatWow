import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_TAURI, MOCK_MODE } from "./tauri";
import type { Tab } from "../types";

export const WINDOW_LABEL = IS_TAURI ? getCurrentWindow().label
  : MOCK_MODE && typeof location !== "undefined"
    ? new URLSearchParams(location.search).get("window") ?? "main" : "main";
export const IS_MAIN_WINDOW = WINDOW_LABEL === "main";
export type ListenerDestination = "window" | "split" | "tab";
export const ownsTab = (tab: Tab, label = WINDOW_LABEL): boolean =>
  (tab.windowLabel ?? "main") === label;
export const windowTabs = (tabs: Tab[], label = WINDOW_LABEL): Tab[] =>
  tabs.filter((tab) => ownsTab(tab, label));

/** CSS coordinates in the creating webview, converted to desktop pixels by Rust. */
export type WindowAnchor = { x: number; y: number };

export function windowAnchor(button: HTMLElement): WindowAnchor {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}
