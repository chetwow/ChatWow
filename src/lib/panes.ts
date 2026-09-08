import type { PaneIndex, PaneLayout, PaneNode, Preferences, SplitDirection, Tab } from "../types";

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(0.85, Math.max(0.15, ratio)) : 0.5;

export function paneIds(root: PaneNode): PaneIndex[] {
  return root.kind === "pane" ? [root.id] : [...paneIds(root.first), ...paneIds(root.second)];
}

/** The window's upper-right corner follows right branches and upper branches. */
export function topRightPane(root: PaneNode): PaneIndex {
  return root.kind === "pane" ? root.id : topRightPane(root.axis === "row" ? root.second : root.first);
}

/** Reject malformed trees as a whole; discard stale memberships individually. */
export function normalizePaneLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== "object" || !("root" in raw)) return null;
  const panes = new Set<number>();
  const branches = new Set<string>();
  const read = (value: unknown, depth: number): PaneNode | null => {
    if (!value || typeof value !== "object" || depth > 64) return null;
    const node = value as Record<string, unknown>;
    if (node.kind === "pane") {
      if (typeof node.id !== "number" || !Number.isSafeInteger(node.id) || node.id < 0 || panes.has(node.id)) return null;
      panes.add(node.id);
      return { kind: "pane", id: node.id };
    }
    if (node.kind !== "split" || typeof node.id !== "string" || branches.has(node.id)
      || (node.axis !== "row" && node.axis !== "column")) return null;
    branches.add(node.id);
    const first = read(node.first, depth + 1);
    const second = read(node.second, depth + 1);
    return first && second ? {
      kind: "split", id: node.id, axis: node.axis,
      ratio: clampRatio(typeof node.ratio === "number" ? node.ratio : NaN), first, second,
    } : null;
  };
  const root = read(raw.root, 0);
  if (!root) return null;
  const assignments = "tabPanes" in raw && raw.tabPanes && typeof raw.tabPanes === "object" ? raw.tabPanes : {};
  const tabPanes = Object.fromEntries(Object.entries(assignments).filter(([, pane]) => panes.has(pane)));
  return { root, tabPanes };
}

/** Legacy settings are read until the first layout edit saves the tree. */
export function getPaneLayout({ tabs, preferences }: { tabs: Tab[]; preferences: Preferences }): PaneLayout {
  if (preferences.paneLayout) return preferences.paneLayout;
  if (preferences.splitLayout === "none") return { root: { kind: "pane", id: 0 }, tabPanes: {} };
  return {
    root: {
      kind: "split", id: "legacy", axis: preferences.splitLayout, ratio: preferences.splitRatio,
      first: { kind: "pane", id: 0 }, second: { kind: "pane", id: 1 },
    },
    tabPanes: Object.fromEntries(tabs.map((tab, index) => [tab.id, index < preferences.splitIndex ? 0 : 1])),
  };
}

export function mapPaneNode(root: PaneNode, change: (node: PaneNode) => PaneNode): PaneNode {
  const next = root.kind === "pane" ? root : {
    ...root, first: mapPaneNode(root.first, change), second: mapPaneNode(root.second, change),
  };
  return change(next);
}

/** Remove one leaf and promote its sibling, preserving every other divider. */
export function withoutPane(root: PaneNode, pane: PaneIndex): PaneNode | null {
  if (root.kind === "pane") return root.id === pane ? null : root;
  const first = withoutPane(root.first, pane);
  const second = withoutPane(root.second, pane);
  return first && second ? { ...root, first, second } : first ?? second;
}

/** The sibling subtree expands into a removed pane; merge into its nearest leaf. */
export function siblingPane(root: PaneNode, pane: PaneIndex): PaneIndex | null {
  if (root.kind === "pane") return null;
  if (root.first.kind === "pane" && root.first.id === pane) return paneIds(root.second)[0];
  if (root.second.kind === "pane" && root.second.id === pane) {
    const siblings = paneIds(root.first);
    return siblings[siblings.length - 1];
  }
  return siblingPane(root.first, pane) ?? siblingPane(root.second, pane);
}

export type PaneRect = { id: PaneIndex; left: number; top: number; right: number; bottom: number };

/** Prefer an aligned neighbor, then the nearest panel in the requested direction. */
export function adjacentPane(rects: PaneRect[], selected: PaneIndex, direction: SplitDirection): PaneIndex {
  const from = rects.find((rect) => rect.id === selected);
  if (!from) return selected;
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down" ? 1 : -1;
  const center = (rect: PaneRect) => horizontal
    ? [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2]
    : [(rect.top + rect.bottom) / 2, (rect.left + rect.right) / 2];
  const [along, across] = center(from);
  const ranked = rects.filter((rect) => rect.id !== selected).map((rect) => {
    const [nextAlong, nextAcross] = center(rect);
    const distance = (nextAlong - along) * forward;
    const overlap = horizontal
      ? Math.min(from.bottom, rect.bottom) - Math.max(from.top, rect.top)
      : Math.min(from.right, rect.right) - Math.max(from.left, rect.left);
    return { id: rect.id, distance, across: Math.abs(nextAcross - across), aligned: overlap > 1 };
  }).filter((rect) => rect.distance > 1);
  ranked.sort((a, b) => Number(b.aligned) - Number(a.aligned) || a.distance - b.distance || a.across - b.across);
  return ranked[0]?.id ?? selected;
}
