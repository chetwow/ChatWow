import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "../store/chat";

/** Matches the row's gap-x-1. */
const TAB_GAP = 4;
/** Safety margin for offsetWidth's whole-pixel rounding vs. real fractional layout. */
const ROUNDING_SLOP = 2;

export function TabBar({ onAdd }: { onAdd: () => void }) {
  const channels = useChat((state) => state.channels);
  const active = useChat((state) => state.active);
  const unread = useChat((state) => state.unread);
  const mentions = useChat((state) => state.mentions);
  const ready = useChat((state) => state.ready);
  const setActive = useChat((state) => state.setActive);
  const part = useChat((state) => state.part);
  const reorderChannels = useChat((state) => state.reorderChannels);

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const rowRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

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

    channels.forEach((channel, index) => {
      const tabWidth = tabRefs.current.get(channel)?.offsetWidth ?? 0;
      // The last tab must also leave room for the add button right after it
      // on the same row -- otherwise the button would be the one bumped to
      // a new row, alone, instead of joining this tab there.
      const isLastTab = index === channels.length - 1;
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
  useLayoutEffect(recompute, [channels]);

  // Recompute whenever a tab (or the row, or the add button) actually
  // changes size -- an unread count ticking up, a ready-dot appearing, a
  // window resize. Driving this off a ResizeObserver instead of off `unread`
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (dragIndex === null) return;
    window.addEventListener("dragenter", allowDrop);
    window.addEventListener("dragover", allowDrop);
    return () => {
      window.removeEventListener("dragenter", allowDrop);
      window.removeEventListener("dragover", allowDrop);
    };
  }, [dragIndex]);

  const moveTab = (from: number, to: number) => {
    if (from === to) return;
    const next = channels.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorderChannels(next);
  };

  // Which wrapped row each tab lands on, purely so tabs past the first row
  // can get a top border -- without it, a wrapped row reads as a continuation
  // of the one above instead of a visually distinct line of tabs.
  let rowIndex = 0;
  const rowIndexByTabIndex = channels.map((_, index) => {
    const current = rowIndex;
    if (breakAfter.has(index)) rowIndex += 1;
    return current;
  });

  return (
    <div
      ref={rowRef}
      className="flex shrink-0 flex-wrap items-stretch gap-x-1 border-b border-line bg-surface-raised px-1"
      onDragEnter={(event) => {
        // Without this, crossing the gaps/padding between tabs (or the add
        // button) flashes the browser's "not allowed" cursor, since only the
        // tab cells themselves otherwise accept a drop.
        if (dragIndex !== null) allowDrop(event);
      }}
      onDragOver={(event) => {
        if (dragIndex !== null) allowDrop(event);
      }}
    >
      {channels.map((channel, index) => {
        const isActive = channel === active;
        const count = unread[channel] ?? 0;
        // Only the badge's colors change, never its size -- see the slot
        // comment below for why a tab's width has to stay put.
        const named = (mentions[channel] ?? 0) > 0;

        return (
          <Fragment key={channel}>
            <div
              ref={(element) => {
                if (element) {
                  tabRefs.current.set(channel, element);
                  observerRef.current?.observe(element);
                } else {
                  const previous = tabRefs.current.get(channel);
                  if (previous) observerRef.current?.unobserve(previous);
                  tabRefs.current.delete(channel);
                }
              }}
              draggable
              onDragStart={(event) => {
                setDragIndex(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnter={allowDrop}
              onDragOver={allowDrop}
              onDrop={(event) => {
                // Reordering here (rather than live, on dragover) avoids
                // shuffling the DOM under the cursor while the drag is still
                // in progress -- the actual move happens once, on release.
                event.preventDefault();
                if (dragIndex !== null) moveTab(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              onClick={() => setActive(channel)}
              className={`group relative flex h-8 cursor-pointer items-center gap-1 rounded-t-md px-2 text-[12px] transition-colors ${
                isActive
                  ? "bg-surface text-ink"
                  : "text-ink-dim hover:bg-surface-hover hover:text-ink"
              } ${rowIndexByTabIndex[index] > 0 ? "border-t border-line" : ""} ${
                dragIndex === index ? "opacity-50" : ""
              }`}
            >
              {isActive && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}

              <span className="font-medium">
                <span className="text-ink-faint">#</span>
                {channel}
              </span>

              {!ready[channel] && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
              )}

              {/* The close button takes over the unread badge's slot on
                  hover instead of growing the tab to fit alongside it --
                  swapping which of the two is visible never changes the
                  tab's rendered width, so hovering can't shift row-wrapping
                  the way resizing the tab used to. */}
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
                    void part(channel);
                  }}
                  aria-label={`Leave ${channel}`}
                  className="invisible absolute inset-0 grid place-items-center rounded text-ink-faint transition-colors hover:bg-line hover:text-ink group-hover:visible"
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
      })}

      {breakBeforeAdd && <div className="h-1 basis-full" />}

      <button
        ref={addRef}
        onClick={onAdd}
        aria-label="Join a channel"
        title="Join a channel (Ctrl+K)"
        className="-ml-0.5 my-1 grid h-6 w-5 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M6 1 V11 M1 6 H11" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
      </button>
    </div>
  );
}
