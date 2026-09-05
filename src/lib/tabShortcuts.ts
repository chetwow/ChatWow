import type { Tab } from "../types";

export type TabShortcut =
  | { kind: "position"; index: number }
  | { kind: "last" }
  | { kind: "cycle"; direction: -1 | 1 };

type KeyModifiers = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** macOS's standard application Settings shortcut; intentionally absent elsewhere. */
export function isMacSettingsShortcut(event: KeyModifiers, isMac: boolean): boolean {
  return (
    isMac &&
    event.key === "," &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Chrome's reopen-closed-tab shortcut on the platform primary modifier. */
export function isReopenClosedTabShortcut(event: KeyModifiers, isMac: boolean): boolean {
  const primary = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return primary && event.shiftKey && !event.altKey && event.key.toLowerCase() === "t";
}

/** Read only the platform's Chrome-style tab shortcuts from a key event. */
export function tabShortcut(event: KeyModifiers, isMac: boolean): TabShortcut | null {
  const key = event.key.toLowerCase();
  const primary = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  if (primary && !event.altKey && !event.shiftKey && /^[1-8]$/.test(key)) {
    return { kind: "position", index: Number(key) - 1 };
  }
  if (primary && !event.altKey && !event.shiftKey && key === "9") {
    return { kind: "last" };
  }

  if (
    !isMac &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    key === "tab"
  ) {
    return { kind: "cycle", direction: event.shiftKey ? -1 : 1 };
  }

  if (
    isMac &&
    event.metaKey &&
    event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (key === "arrowleft" || key === "arrowright")
  ) {
    return { kind: "cycle", direction: key === "arrowleft" ? -1 : 1 };
  }

  return null;
}

/** Resolve a shortcut against the one persisted tab order. */
export function tabForShortcut(
  tabs: Tab[],
  currentId: string | null,
  shortcut: TabShortcut,
): Tab | null {
  if (tabs.length === 0) return null;
  if (shortcut.kind === "position") return tabs[shortcut.index] ?? null;
  if (shortcut.kind === "last") return tabs[tabs.length - 1];

  const current = tabs.findIndex((tab) => tab.id === currentId);
  if (current < 0) return shortcut.direction > 0 ? tabs[0] : tabs[tabs.length - 1];
  const next = (current + shortcut.direction + tabs.length) % tabs.length;
  return tabs[next];
}
