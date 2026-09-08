import { useRef, useState, type DragEvent, type PointerEvent } from "react";
import { useInlineVideo } from "../store/inlineVideo";
import { VideoTabContext } from "./VideoTabContext";
import { TabBar } from "./TabBar";
import { ChatView } from "./ChatView";
import { ChatZoomControl } from "./ChatZoomControl";
import { PinnedMessagePanel } from "./PinnedMessagePanel";
import { paneTabs, useChat } from "../store/chat";
import { clampRatio, getPaneLayout, topRightPane } from "../lib/panes";
import { useTabDrag } from "../store/tabDrag";
import type { PaneIndex, PaneNode } from "../types";

/** The divider's own thickness, and the whole of its grab area. */
const DIVIDER = 5;

export type TabSearchSession = { tabId: string; request: number };

/**
 * Nothing joined: the ways in, and nothing else. Signing in is offered
 * alongside because the title bar's own button is easy to miss on a screen
 * that's otherwise empty -- but it stays secondary, since reading a channel
 * doesn't need an account.
 */
function EmptyPane({ onAdd, onSignIn }: { onAdd: () => void; onSignIn: () => void }) {
  const loggedIn = useChat((state) => state.auth.accounts.length > 0);
  return (
    <div className="flex flex-1 items-center justify-center gap-2">
      <button
        onClick={onAdd}
        className="rounded-md bg-accent px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim"
      >
        Join a channel
      </button>
      {!loggedIn && (
        <button
          onClick={onSignIn}
          className="rounded-md border border-line px-4 py-2 text-[12px] font-semibold text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Sign in
        </button>
      )}
    </div>
  );
}

/**
 * One leaf of the layout: a row of tabs and
 * whichever of them is open. All panes read the same store -- a channel is
 * joined, resolved and stored once however many panes are on screen.
 * The visible tab and transcript zoom belong to each pane.
 */
function Pane({
  pane,
  onAdd,
  onSignIn,
  search,
  onCloseSearch,
}: {
  pane: PaneIndex;
  onAdd: () => void;
  onSignIn: () => void;
  search: TabSearchSession | null;
  onCloseSearch: () => void;
}) {
  const active = useChat((state) => state.active[pane]);
  const playerTab = useInlineVideo((state) => state.tabId);
  const keepInactive = useChat((state) => state.preferences.keepVideoPlayersInactive);
  const tabs = useChat((state) => state.tabs);
  const preferences = useChat((state) => state.preferences);
  const globalZoomHost = preferences.zoomAllSplits && topRightPane(getPaneLayout({ tabs, preferences }).root) === pane;
  const visibleTabs = paneTabs({ tabs, preferences }, pane)
    .filter((tab) => tab.id === active || (keepInactive && tab.id === playerTab));
  const focusPane = useChat((state) => state.focusPane);
  const moveTab = useChat((state) => state.moveTab);
  /**
   * Which pane's composer answers to typing anywhere in the window. Both
   * composers reclaim focus the moment you type (chat should feel
   * always-focused), so exactly one of them can be listening or the two
   * would fight over every keystroke. It's the focused pane -- unless that
   * pane has nothing open, in which case typing would go nowhere and the
   * other pane takes it.
   */
  const typingPane = useChat((state) =>
    state.active[state.focusedPane] ? state.focusedPane : Number(Object.keys(state.active).find((id) => state.active[Number(id)])),
  );
  // A tab dragged from the *other* pane can be dropped anywhere in this one,
  // not just on its tab bar -- there may be no tabs there to aim at.
  const foreignDrag = useTabDrag((state) => (state.drag?.pane === pane ? null : state.drag));
  const endDrag = useTabDrag((state) => state.end);

  const acceptDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!foreignDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };

  return (
    <div
      data-pane-id={pane}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      // Capture, so a click lands the focus here before whatever it was a
      // click *on* runs -- joining a channel from this pane's add button has
      // to know this is the pane it's joining into.
      onPointerDownCapture={(event) => {
        if (!(event.target as Element).closest("[data-global-chat-zoom]")) focusPane(pane);
      }}
      onFocusCapture={(event) => {
        if (!event.target.closest("[data-global-chat-zoom]")) focusPane(pane);
      }}
      onDragEnter={acceptDrop}
      onDragOver={acceptDrop}
      onDrop={(event) => {
        if (!foreignDrag) return;
        event.preventDefault();
        moveTab(foreignDrag.tab, pane, paneTabs(useChat.getState(), pane).length);
        endDrag();
      }}
    >
      <TabBar pane={pane} onAdd={onAdd} />
      {globalZoomHost && (
        // The pill's static vertical position follows this tab bar. Fixed
        // positioning gives it the window's width even in a narrow split.
        <div className="relative z-20 shrink-0">
          <ChatZoomControl pane={pane} global />
        </div>
      )}
      {visibleTabs.map((tab) => (
        <VideoTabContext.Provider key={tab.id} value={{ tabId: tab.id, active: tab.id === active }}>
          <div className={tab.id === active ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" : "hidden"}>
            <PinnedMessagePanel tabId={tab.id} />
            <ChatView
              id={tab.id}
              pane={pane}
              capturesTyping={tab.id === active && typingPane === pane}
              searchRequest={tab.id === active && search?.tabId === tab.id ? search.request : null}
              onCloseSearch={onCloseSearch}
            />
          </div>
        </VideoTabContext.Provider>
      ))}
      {!active && <EmptyPane onAdd={onAdd} onSignIn={onSignIn} />}
    </div>
  );
}

/**
 * The draggable border between the panes. The ratio it reports is live and
 * unsaved while the pointer is down -- preferences are written whole to
 * `settings.json` on every change, and a drag would otherwise rewrite that
 * file a hundred times on the way across.
 */
function Divider({
  vertical,
  onDrag,
  onSettle,
}: {
  vertical: boolean;
  onDrag: (event: PointerEvent<HTMLDivElement>) => void;
  onSettle: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      style={vertical ? { width: DIVIDER } : { height: DIVIDER }}
      onPointerDown={(event) => {
        // Pointer capture keeps the moves coming to this element even as the
        // cursor runs out over the chat below, which is where a drag spends
        // most of its time.
        event.currentTarget.setPointerCapture(event.pointerId);
        onDrag(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onDrag(event);
      }}
      onLostPointerCapture={onSettle}
      onPointerCancel={onSettle}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onSettle();
      }}
      // The line itself is one pixel of border; the rest is grab area, which
      // is why the element is wider than what it looks like.
      className={`group relative shrink-0 bg-line/60 transition-colors hover:bg-accent/60 ${
        vertical ? "cursor-col-resize" : "cursor-row-resize"
      }`}
    />
  );
}

type PaneProps = {
  onAdd: () => void;
  onSignIn: () => void;
  search: TabSearchSession | null;
  onCloseSearch: () => void;
};

/** Each branch owns its divider and measures only its own part of the window. */
function PaneBranch({ node, ...props }: PaneProps & { node: Extract<PaneNode, { kind: "split" }> }) {
  const setSplitRatio = useChat((state) => state.setSplitRatio);
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const dragRatio = useRef<number | null>(null);
  const vertical = node.axis === "row";
  const shown = clampRatio(dragging ?? node.ratio);
  const onDrag = (event: PointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const along = vertical
      ? (event.clientX - box.left - DIVIDER / 2) / (box.width - DIVIDER)
      : (event.clientY - box.top - DIVIDER / 2) / (box.height - DIVIDER);
    dragRatio.current = clampRatio(along);
    setDragging(dragRatio.current);
  };
  const settle = () => {
    if (dragRatio.current !== null) setSplitRatio(node.id, dragRatio.current);
    dragRatio.current = null;
    setDragging(null);
  };
  return (
    <div
      ref={container}
      className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${vertical ? "flex-row" : "flex-col"} ${dragging === null ? "" : "select-none"}`}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${shown} 1 0%` }}>
        <PaneTree node={node.first} {...props} />
      </div>
      <Divider vertical={vertical} onDrag={onDrag} onSettle={settle} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - shown} 1 0%` }}>
        <PaneTree node={node.second} {...props} />
      </div>
    </div>
  );
}

function PaneTree({ node, ...props }: PaneProps & { node: PaneNode }) {
  return node.kind === "pane"
    ? <Pane key={node.id} pane={node.id} {...props} />
    : <PaneBranch key={node.id} node={node} {...props} />;
}

export function Panes(props: PaneProps) {
  const preferences = useChat((state) => state.preferences);
  const tabs = useChat((state) => state.tabs);
  return <PaneTree node={getPaneLayout({ tabs, preferences }).root} {...props} />;
}
