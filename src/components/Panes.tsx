import { useRef, useState, type DragEvent, type PointerEvent } from "react";
import { TabBar } from "./TabBar";
import { ChatView } from "./ChatView";
import { clampRatio, paneTabs, useChat } from "../store/chat";
import { useTabDrag } from "../store/tabDrag";
import type { PaneIndex } from "../types";

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
 * One half of the window (or the whole of it, unsplit): a row of tabs and
 * whichever of them is open. Both panes read the same store -- a channel is
 * joined, resolved and stored once however many panes are on screen -- so all
 * that's per-pane here is which tab is showing.
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
    state.active[state.focusedPane] ? state.focusedPane : state.focusedPane === 0 ? 1 : 0,
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
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      // Capture, so a click lands the focus here before whatever it was a
      // click *on* runs -- joining a channel from this pane's add button has
      // to know this is the pane it's joining into.
      onPointerDownCapture={() => focusPane(pane)}
      onFocusCapture={() => focusPane(pane)}
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
      {active ? (
        <ChatView
          key={active}
          id={active}
          capturesTyping={typingPane === pane}
          searchRequest={search?.tabId === active ? search.request : null}
          onCloseSearch={onCloseSearch}
        />
      ) : (
        <EmptyPane onAdd={onAdd} onSignIn={onSignIn} />
      )}
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

/**
 * The window's chat area: one pane, or two with a border you can drag. There
 * are exactly two -- a pane can't itself be split -- so this is a ratio and an
 * axis rather than a tree.
 */
export function Panes({
  onAdd,
  onSignIn,
  search,
  onCloseSearch,
}: {
  onAdd: () => void;
  onSignIn: () => void;
  search: TabSearchSession | null;
  onCloseSearch: () => void;
}) {
  const layout = useChat((state) => state.preferences.splitLayout);
  const ratio = useChat((state) => state.preferences.splitRatio);
  const setSplitRatio = useChat((state) => state.setSplitRatio);
  const container = useRef<HTMLDivElement>(null);
  /** The ratio being dragged to, kept out of the store until the pointer lifts. */
  const [dragging, setDragging] = useState<number | null>(null);

  if (layout === "none") {
    return (
      <Pane
        pane={0}
        onAdd={onAdd}
        onSignIn={onSignIn}
        search={search}
        onCloseSearch={onCloseSearch}
      />
    );
  }

  const vertical = layout === "row";
  const shown = clampRatio(dragging ?? ratio);

  const onDrag = (event: PointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const along = vertical
      ? (event.clientX - box.left) / box.width
      : (event.clientY - box.top) / box.height;
    setDragging(clampRatio(along));
  };

  return (
    <div
      ref={container}
      className={`flex min-h-0 flex-1 overflow-hidden ${vertical ? "flex-row" : "flex-col"} ${
        dragging === null ? "" : "select-none"
      }`}
    >
      {/* Grow factors rather than percentages, so the two panes divide
          whatever the divider doesn't take without any arithmetic about how
          thick it is. */}
      <div className="flex min-h-0 min-w-0" style={{ flex: `${shown} 1 0%` }}>
        <Pane
          pane={0}
          onAdd={onAdd}
          onSignIn={onSignIn}
          search={search}
          onCloseSearch={onCloseSearch}
        />
      </div>
      <Divider
        vertical={vertical}
        onDrag={onDrag}
        onSettle={() => {
          if (dragging !== null) setSplitRatio(dragging);
          setDragging(null);
        }}
      />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - shown} 1 0%` }}>
        <Pane
          pane={1}
          onAdd={onAdd}
          onSignIn={onSignIn}
          search={search}
          onCloseSearch={onCloseSearch}
        />
      </div>
    </div>
  );
}
