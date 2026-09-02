import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { paneTabs, useChat } from "../store/chat";
import { tabAvatar } from "../lib/tabAvatar";
import { useTabDrag } from "../store/tabDrag";
import { AccountMenu } from "./AccountMenu";
import type { PaneIndex, Tab } from "../types";

/** Matches the row's gap-x-1. */
const TAB_GAP = 4;
/** Safety margin for offsetWidth's whole-pixel rounding vs. real fractional layout. */
const ROUNDING_SLOP = 2;

/**
 * One pane's row of tabs. Everything here is about this pane's own tabs --
 * which of them wrap onto which row, which is being dragged, which has a
 * mention past the edge of a scrolled row -- so a split window runs two of
 * these, measuring independently against their own widths.
 */
export function TabBar({ pane, onAdd }: { pane: PaneIndex; onAdd: () => void }) {
  const tabs_ = useChat((state) => state.tabs);
  const preferences = useChat((state) => state.preferences);
  const active = useChat((state) => state.active[pane]);
  const unread = useChat((state) => state.unread);
  const mentions = useChat((state) => state.mentions);
  const ready = useChat((state) => state.ready);
  const live = useChat((state) => state.live);
  const auth = useChat((state) => state.auth);
  const channelAvatars = useChat((state) => state.channelAvatars);
  const setActive = useChat((state) => state.setActive);
  const closeTab = useChat((state) => state.closeTab);
  const moveTab = useChat((state) => state.moveTab);
  /** Which tab's account menu is open, and where it was opened. */
  const [accountMenu, setAccountMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // One scrolling row, or as many wrapped rows as the tabs need.
  const singleRow = preferences.singleRowTabs;

  /**
   * This pane's tabs, in bar order: its channels with the mentions tab
   * dropped in if this is where it lives. Everything below -- measuring,
   * wrapping, dragging, the scrolled-off-edge check -- runs over this rather
   * than `channels`, so the extra tab is an ordinary tab in every respect and
   * the other pane's tabs are simply not here.
   *
   * Memoized against the two things it's derived from: both are stable
   * references until something really changes, where a fresh array on every
   * store update would re-measure the row on every incoming message.
   */
  const tabList = useMemo(
    () => paneTabs({ tabs: tabs_, preferences }, pane),
    [tabs_, preferences, pane],
  );
  /** Cheap dependency for effects that only care that the tabs changed. */
  const tabKey = tabList.map((tab) => `${tab.id}:${tab.account}`).join(" ");

  // Shared with the other pane's bar: a tab dragged across the divider is
  // lifted in one of these components and dropped in the other.
  const drag = useTabDrag((state) => state.drag);
  const startDrag = useTabDrag((state) => state.start);
  const endDrag = useTabDrag((state) => state.end);

  const rowRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Which edges of the scrolling row have a tab naming you somewhere past
  // them. Only ever set in single-row mode -- when the tabs wrap, every badge
  // is already on screen.
  const [hiddenMentions, setHiddenMentions] = useState({ left: false, right: false });

  // The close button shares a fixed-size slot with the unread badge (see
  // below) instead of growing the tab on hover, so a tab's rendered width
  // never changes just from hovering it. That leaves exactly one reason a
  // row still needs a forced break: the add button must never end up alone
  // on its own row, so the last tab has to also leave room for it.
  const [breakAfter, setBreakAfter] = useState<Set<number>>(new Set());
  const [breakBeforeAdd, setBreakBeforeAdd] = useState(false);

  const recompute = () => {
    const row = rowRef.current;
    const addButton = addRef.current;
    // Nothing to bucket in single-row mode: the row never wraps, and its
    // container isn't even mounted (rowRef is null), so any breaks left over
    // from wrap mode have to be dropped rather than measured again.
    if (singleRow) {
      setBreakAfter((prev) => (prev.size === 0 ? prev : new Set()));
      setBreakBeforeAdd((prev) => (prev ? false : prev));
      return;
    }
    if (!row || !addButton) return;

    // clientWidth is the row's padding-box width, but flex children are laid
    // out within its content box -- comparing tab widths against clientWidth
    // directly overstates the space actually available to them by exactly
    // the row's own horizontal padding.
    const style = getComputedStyle(row);
    const containerWidth =
      row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const addButtonSpace = TAB_GAP + addButton.offsetWidth;
    const nextBreaks = new Set<number>();
    let rowWidth = 0;
    let rowHasTabs = false;

    tabList.forEach((tab, index) => {
      const tabWidth = tabRefs.current.get(tab.id)?.offsetWidth ?? 0;
      // The last tab must also leave room for the add button right after it
      // on the same row -- otherwise the button would be the one bumped to
      // a new row, alone, instead of joining this tab there.
      const isLastTab = index === tabList.length - 1;
      const reserve = isLastTab ? addButtonSpace : 0;
      const gap = rowHasTabs ? TAB_GAP : 0;
      // offsetWidth rounds to whole pixels while the real layout is done in
      // fractional ones, so an exact-looking fit here can still overflow by
      // a hair in the browser -- ROUNDING_SLOP keeps this on the safe side
      // of that instead of relying on native wrap to bail us out (which is
      // what caused a tab to land on a forced-break row all by itself).
      if (rowHasTabs && rowWidth + gap + tabWidth + reserve + ROUNDING_SLOP > containerWidth) {
        nextBreaks.add(index - 1);
        rowWidth = tabWidth;
      } else {
        rowWidth += gap + tabWidth;
      }
      rowHasTabs = true;
    });

    // Fallback for the pathological case where even a lone tab plus the add
    // button can't fit on one row -- let the button wrap on its own rather
    // than overflow.
    const nextBreakBeforeAdd =
      rowHasTabs && rowWidth + addButtonSpace + ROUNDING_SLOP > containerWidth;

    // Guard against a redundant render when nothing actually changed -- a
    // ResizeObserver tick doesn't guarantee the measured sizes came out any
    // different than last time.
    setBreakAfter((prev) =>
      prev.size === nextBreaks.size && [...prev].every((value) => nextBreaks.has(value))
        ? prev
        : nextBreaks,
    );
    setBreakBeforeAdd((prev) => (prev === nextBreakBeforeAdd ? prev : nextBreakBeforeAdd));
  };

  // The ResizeObserver below is created once; route it through a ref so its
  // callback always runs the latest recompute (current channels/etc) instead
  // of whatever closure existed when the observer was constructed.
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  // Recompute whenever the channel list itself changes shape (join, part,
  // drag-reorder) -- this can change bucketing even when no individual tab's
  // rendered width changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(recompute, [tabKey, singleRow]);

  // Recompute whenever a tab (or the row, or the add button) actually
  // changes size -- an unread count gaining a digit, a window resize. (The
  // status dot no longer counts: its slot is reserved whether or not a dot
  // is in it.) Driving this off a ResizeObserver instead of off `unread`
  // directly matters: `unread` changes on every incoming message, far more
  // often than any tab's rendered width actually does (most increments don't
  // even change the badge's digit count), so watching it directly was
  // recomputing -- and re-rendering -- many times a second under a busy
  // channel, which is what made a borderline tab visibly flap between rows.
  useEffect(() => {
    const observer = new ResizeObserver(() => recomputeRef.current());
    observerRef.current = observer;
    const row = rowRef.current;
    if (row) observer.observe(row);
    if (addRef.current) observer.observe(addRef.current);
    tabRefs.current.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
    // Rebuilt when the mode changes: switching back to wrapping mounts a new
    // row element, which the observer from the first mount knows nothing about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleRow]);

  // Keep the active tab on screen. In wrap mode every tab is always visible,
  // but a scrolling row can easily have the one you just switched to (Ctrl+Tab,
  // or a channel you've only just joined) sitting off its right edge.
  useEffect(() => {
    if (!singleRow || !active) return;
    tabRefs.current.get(active)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, singleRow]);

  // A rose badge that's scrolled out of the row is the one thing the tab bar
  // can't just show you -- so mark the edge it's past. Measured with
  // `getBoundingClientRect` rather than `offsetLeft`: a tab's offsetParent is
  // the wrapper *outside* the scroller (the tabs are `relative` for their
  // active underline), so its offsets don't move as the row scrolls.
  const checkHiddenMentions = () => {
    const scroller = scrollerRef.current;
    if (!singleRow || !scroller) {
      setHiddenMentions((prev) => (prev.left || prev.right ? { left: false, right: false } : prev));
      return;
    }
    const box = scroller.getBoundingClientRect();
    let left = false;
    let right = false;
    for (const tab of tabList) {
      // Same condition as the badge itself: reading a tab clears its
      // mentions, and the active tab shows no badge to be missing. A mentions
      // tab is exempt on top of that -- the bar means "something named you
      // past this edge", and pointing at the tab those are already gathered
      // in says nothing you didn't know.
      if (tab.kind === "mentions") continue;
      if (tab.id === active || (mentions[tab.id] ?? 0) === 0) continue;
      const rect = tabRefs.current.get(tab.id)?.getBoundingClientRect();
      if (!rect) continue;
      // A tab clipped by a pixel is still readable, hence the tolerance.
      if (rect.left < box.left - 1) left = true;
      else if (rect.right > box.right + 1) right = true;
    }
    setHiddenMentions((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  };

  const checkRef = useRef(checkHiddenMentions);
  checkRef.current = checkHiddenMentions;

  // Which channels are waiting on you, as a value that only changes when the
  // answer does -- `mentions` itself is a fresh object on every batch of
  // messages, which would re-measure the row a dozen times a second.
  const mentionKey = tabList
    .filter((tab) => tab.kind !== "mentions" && tab.id !== active && (mentions[tab.id] ?? 0) > 0)
    .map((tab) => tab.id)
    .join(" ");

  useLayoutEffect(() => {
    checkRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionKey, tabKey, singleRow]);

  // The row scrolling isn't the only way a badge crosses an edge: resizing the
  // window moves the right one under the tabs.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => checkRef.current());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [singleRow]);

  // The browser decides whether a drop is allowed (and so which cursor to
  // show) starting at dragenter, not dragover -- a handler that only cancels
  // dragover leaves a brief window right as the pointer enters each new
  // element where the "not allowed" cursor flashes before the next dragover
  // catches up. Cancel both, everywhere a drop should be accepted.
  const allowDrop = (event: { preventDefault(): void; dataTransfer: DataTransfer | null }) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };

  // The tab bar's own handlers only cover its own box -- a real drag easily
  // strays a pixel above into the title bar or below into the chat view, so
  // accept the drop everywhere while a tab drag is in progress.
  useEffect(() => {
    if (!drag) return;
    window.addEventListener("dragenter", allowDrop);
    window.addEventListener("dragover", allowDrop);
    return () => {
      window.removeEventListener("dragenter", allowDrop);
      window.removeEventListener("dragover", allowDrop);
    };
  }, [drag]);

  /**
   * Take the drop: the store works out what moving this tab here means for
   * the channel order, the split boundary and the mentions tab's place. An
   * index of `tabList.length` is the drop on the bar's own background, which
   * is how a tab is dragged into a pane with no tabs to aim at.
   */
  const dropAt = (event: { preventDefault(): void; stopPropagation(): void }, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (drag) moveTab(drag.tab, pane, index);
    endDrag();
  };

  // Which wrapped row each tab lands on, purely so tabs past the first row
  // can get a top border -- without it, a wrapped row reads as a continuation
  // of the one above instead of a visually distinct line of tabs.
  let rowIndex = 0;
  const rowIndexByTabIndex = tabList.map((_, index) => {
    const current = rowIndex;
    if (breakAfter.has(index)) rowIndex += 1;
    return current;
  });

  // Shared by both modes -- only the container around them differs, and the
  // break spacers below are inert in single-row mode because `recompute`
  // leaves `breakAfter` empty there.
  const tabs = tabList.map((tab: Tab, index) => {
    const isActive = tab.id === active;
    const isMentions = tab.kind === "mentions";
    const count = unread[tab.id] ?? 0;
    // Only the badge's colors change, never its size -- see the slot
    // comment below for why a tab's width has to stay put.
    const named = (mentions[tab.id] ?? 0) > 0;
    const avatar = tabAvatar(tab, auth, channelAvatars);

    return (
      <Fragment key={tab.id}>
        <div
          ref={(element) => {
            if (element) {
              tabRefs.current.set(tab.id, element);
              observerRef.current?.observe(element);
            } else {
              const previous = tabRefs.current.get(tab.id);
              if (previous) observerRef.current?.unobserve(previous);
              tabRefs.current.delete(tab.id);
            }
          }}
          draggable
          onDragStart={(event) => {
            startDrag({ tab: tab.id, pane });
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnter={allowDrop}
          onDragOver={allowDrop}
          // Reordering here (rather than live, on dragover) avoids shuffling
          // the DOM under the cursor while the drag is still in progress --
          // the actual move happens once, on release.
          onDrop={(event) => dropAt(event, index)}
          onDragEnd={endDrag}
          onClick={() => setActive(tab.id, pane)}
          // Right-click is where a tab's account is changed -- the tab is the
          // thing being changed, so it's the thing you aim at.
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setAccountMenu({ id: tab.id, x: event.clientX, y: event.clientY });
          }}
          className={`group relative flex h-8 cursor-pointer items-center gap-1 rounded-t-md pl-1.5 pr-0.5 text-[12px] transition-colors ${
            isActive ? "bg-surface text-ink" : "text-ink-dim hover:bg-surface-hover hover:text-ink"
          } ${rowIndexByTabIndex[index] > 0 ? "border-t border-line" : ""} ${
            drag?.tab === tab.id ? "opacity-50" : ""
          }`}
        >
          {isActive && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}

          {/* Whose face sits behind the name is the tab's own choice, stamped
              when it opened and changed from its right-click menu.
              Absolutely positioned and
              centred on the text rather than laid out beside it: a tab's
              rendered width is what the row-wrap measurement reads, so
              nothing here may take horizontal space, and an image that
              arrives late must not reflow the row it's in. */}
          <span className="relative font-medium">
            {avatar && (
              <img
                src={avatar}
                alt=""
                aria-hidden
                style={{ opacity: preferences.tabAvatarOpacity }}
                className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full object-cover"
              />
            )}
            <span className="relative">
              <span className="text-ink-faint">{isMentions ? "@" : "#"}</span>
              {isMentions ? "mentions" : tab.channel}
            </span>
          </span>

          {/* The slot is always here, whether or not there's a dot in it.
              Rendering the dot conditionally changed the tab's width the
              moment a channel finished loading or went live, and a width
              change is exactly what corrupts the row-wrap measurement
              mid-transition -- same reason the close button shares the
              badge's slot below. */}
          <span className="grid h-1.5 w-1.5 shrink-0 place-items-center">
            {/* Nothing to load and nothing to be live: the mentions tab keeps
                the slot only so it's the same shape as its neighbours. */}
            {isMentions ? null : !ready[tab.id] ? (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            ) : live[tab.channel] ? (
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            ) : null}
          </span>

          {/* The close button takes over the unread badge's slot on hover
              instead of growing the tab to fit alongside it -- swapping
              which of the two is visible never changes the tab's rendered
              width, so hovering can't shift row-wrapping the way resizing
              the tab used to. */}
          <span className="relative grid h-4 w-6 shrink-0 place-items-center">
            {!isActive && count > 0 && (
              <span
                className={`absolute inset-0 grid place-items-center rounded-full text-[10px] font-semibold group-hover:invisible ${
                  named ? "bg-rose-500/25 text-rose-300" : "bg-accent/20 text-accent"
                }`}
              >
                {count > 99 ? "99+" : count}
              </span>
            )}
            <button
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.id);
              }}
              aria-label={isMentions ? "Close the mentions tab" : `Leave ${tab.channel}`}
              // Square, and pinned to the right of the slot rather than
              // filling or centring in it. The slot has to stay as wide as
              // "99+" for the badge it shares, but the X shouldn't inherit
              // that width as a lozenge, nor leave the slot's leftover
              // width sitting as dead space against the tab's edge.
              className="invisible absolute right-0 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-ink-faint transition-colors hover:bg-line hover:text-ink group-hover:visible"
            >
              <svg width="7" height="7" viewBox="0 0 10 10">
                <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
              </svg>
            </button>
          </span>
        </div>

        {breakAfter.has(index) && <div className="h-1 basis-full" />}
      </Fragment>
    );
  });

  // Without this, crossing the gaps/padding between tabs (or the add button)
  // flashes the browser's "not allowed" cursor, since only the tab cells
  // themselves otherwise accept a drop.
  const dragHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (drag) allowDrop(event);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (drag) allowDrop(event);
    },
    // Anywhere in the bar that isn't a tab means the end of the row -- which
    // is the only target an empty pane's bar has.
    onDrop: (event: DragEvent<HTMLDivElement>) => dropAt(event, tabList.length),
  };

  const addButton = (
    <button
      ref={addRef}
      onClick={onAdd}
      aria-label="Join a channel"
      title="Join a channel (Ctrl+K)"
      className={`my-1 grid h-6 w-5 shrink-0 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink ${
        singleRow ? "ml-1 self-start" : "-ml-0.5"
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path d="M6 1 V11 M1 6 H11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    </button>
  );

  const menu = accountMenu && (
    <AccountMenu
      tabId={accountMenu.id}
      x={accountMenu.x}
      y={accountMenu.y}
      onClose={() => setAccountMenu(null)}
    />
  );

  if (singleRow) {
    // The button sits outside the scroller so it stays pinned to the right
    // edge rather than riding away with the last tab. `self-start` keeps it
    // level with the tabs instead of centred against the scrollbar's gutter.
    return (
      <div
        className="relative flex shrink-0 items-stretch border-b border-line bg-surface-raised px-1"
        {...dragHandlers}
      >
        <div className="min-w-0 flex-1">
          <div
            ref={scrollerRef}
            onScroll={() => checkRef.current()}
            className="quiet-scroller flex items-start gap-x-1 overflow-x-auto"
            {...dragHandlers}
          >
            {tabs}
          </div>
        </div>
        {addButton}
        {/* Anchored to the bar itself, outside its padding and past the add
            button -- an absolute child of the scroller would be part of what
            scrolls and slide off the very edge it marks, and one anchored to
            the scroller's box would stop short of the window's edge. */}
        {hiddenMentions.left && <MentionEdge side="left" />}
        {hiddenMentions.right && <MentionEdge side="right" />}
        {menu}
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="flex shrink-0 flex-wrap items-stretch gap-x-1 border-b border-line bg-surface-raised px-1"
      {...dragHandlers}
    >
      {tabs}
      {breakBeforeAdd && <div className="h-1 basis-full" />}
      {addButton}
      {menu}
    </div>
  );
}

/**
 * The rose bar at an edge of the tab bar, meaning: a tab past this side is
 * holding a mention. Flush to the window's edge and the bar's full height, so
 * it reads as part of the chrome rather than something floating between the
 * tabs -- and in the mention highlight's own `rose-400/70`, the same signal at
 * the same strength as the stripe down a message that names you.
 */
function MentionEdge({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 w-[3px] bg-rose-400/70 ${
        side === "left" ? "left-0" : "right-0"
      }`}
    />
  );
}
