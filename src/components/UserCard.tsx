import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageBody } from "./MessageRow";
import { useChat } from "../store/chat";
import { cachedUserCard, describeSince, formatDate, loadUserCard } from "../lib/userCard";
import type { StoredMessage, UserCard as UserCardData } from "../types";

/** The gap between the card and the name it hangs off. */
const GAP = 6;
/** Keep it off the window edges, the same inset the context menu uses. */
const MARGIN = 8;

/**
 * The card is sized from the window rather than pinned to one box: a share of
 * the width, bounded at both ends. The floor is what the widest stat row needs
 * ("Account created" against "May 18, 2011 · 15 years") and the ceiling is where
 * a card stops reading as a card and starts reading as a panel.
 */
const WIDTH_RATIO = 0.3;
const MIN_WIDTH = 300;
const MAX_WIDTH = 420;

/**
 * The message log gets a share of the height on the same terms. It's the only
 * section that can give, so on a short window it shrinks below the floor too --
 * `min-h-0` on its column is what allows that.
 */
const LOG_RATIO = 0.35;
const MIN_LOG = 120;
const MAX_LOG = 320;

/** Below this there's no card worth drawing, whatever the window says. */
const MIN_HEIGHT = 120;

const clamp = (low: number, value: number, high: number) =>
  Math.max(low, Math.min(value, high));

export type UserCardTarget = {
  login: string;
  displayName: string;
  color: string;
  /**
   * The channel the clicked message was said in -- not necessarily the one
   * being viewed, since the mentions tab mixes several. The follow and
   * subscription lines are about this pair, and so is the log below them.
   */
  channel: string;
  /** The clicked name's box, which the card hangs off. */
  anchor: DOMRect;
};

function timeOf(ts: number) {
  if (!ts) return "";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="min-w-0 truncate text-right text-ink-dim">{children}</span>
    </div>
  );
}

/** A date and how long ago it was -- the second half is why you opened the card. */
function Since({ iso }: { iso: string }) {
  return (
    <>
      {formatDate(iso)} <span className="text-ink-faint">· {describeSince(iso)}</span>
    </>
  );
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * The subscription line. Four different things, and saying the wrong one is
 * worse than saying nothing: a lapsed sub still carries its cumulative months,
 * so "148 months" alone would claim a subscriber who left years ago.
 */
function SubLine({ history }: { history: NonNullable<UserCardData["history"]> }) {
  if (history.subHidden) return <span className="text-ink-faint">Hidden</span>;
  if (history.subscribed) {
    const tier = history.subTier && history.subTier !== "1" ? `Tier ${history.subTier} · ` : "";
    return (
      <>
        {tier}
        {plural(history.subMonths, "month")}
      </>
    );
  }
  if (history.subMonths > 0) {
    return (
      <>
        {plural(history.subMonths, "month")} <span className="text-ink-faint">· lapsed</span>
      </>
    );
  }
  return <span className="text-ink-faint">Never</span>;
}

/**
 * Everything we know about one chatter, opened by clicking their name.
 *
 * The top half is fetched (see `lib/userCard.ts` and `usercard.rs`); the bottom
 * half is free, being whatever they've already said in this channel since
 * launch. That log is deliberately this channel only -- the same name in two
 * tabs is two conversations, and merging them would read as one.
 *
 * The card sizes itself against the window rather than to a fixed box, in both
 * directions: it takes a share of the width and gives the log a share of the
 * height, each bounded so it neither outgrows a maximized window nor overflows
 * the smallest one this app allows (420x320, `tauri.conf.json`). When even the
 * floor doesn't fit, the log is the part that gives -- it's the only section
 * that can shrink without losing anything, having a scrollbar already.
 */
export function UserCard({
  target,
  onClose,
  onCreateListener,
}: {
  target: UserCardTarget;
  onClose: () => void;
  onCreateListener?: () => void;
}) {
  const { login, displayName, color, channel, anchor } = target;
  const ref = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<UserCardData | null>(
    () => cachedUserCard(login, channel) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Messages are keyed by tab, not by channel, and a channel can be open under
  // two accounts at once -- so the log is gathered from every tab on this
  // channel rather than looked up by name. The two copies are the same
  // messages arriving down two sockets, which is what the id dedupe is for.
  // Going through the tabs also means a name clicked in the mentions tab shows
  // that channel's whole log rather than only the lines that named you.
  const allMessages = useChat((state) => state.messages);
  const tabs = useChat((state) => state.tabs);

  const theirs = useMemo(() => {
    // A mentions tab carries no channel, so an empty one here would match it
    // and gather a log that isn't about this room.
    if (!channel) return [];
    const seen = new Set<string>();
    const found: StoredMessage[] = [];
    for (const tab of tabs) {
      if (tab.channel !== channel) continue;
      for (const message of allMessages[tab.id] ?? []) {
        if (message.login !== login) continue;
        // A message Twitch didn't give an id (a local notice) can't be
        // deduped, but can't be a duplicate either -- it was never sent twice.
        if (message.id) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
        }
        found.push(message);
      }
    }
    // Two tabs' worth interleave by time rather than landing in tab order.
    return found.sort((a, b) => a.ts - b.ts);
  }, [allMessages, tabs, channel, login]);

  useEffect(() => {
    if (card) return;
    let live = true;
    loadUserCard(login, channel).then(
      (loaded) => live && setCard(loaded),
      (reason) => live && setError(String(reason)),
    );
    return () => {
      live = false;
    };
  }, [card, login, channel]);

  // The newest messages, the way chat itself sits -- someone with a hundred
  // lines this session opens on what they just said, not on what they said an
  // hour ago.
  useLayoutEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [theirs]);

  // Tracked rather than read inline, so resizing the window re-lays an open
  // card out instead of leaving it hanging over an edge that moved.
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Never wider than the window can hold, whatever the ratio asks for -- this
  // window goes down to 420x320 (`tauri.conf.json`), narrower than the floor.
  const width = Math.min(
    clamp(MIN_WIDTH, Math.round(viewport.width * WIDTH_RATIO), MAX_WIDTH),
    viewport.width - MARGIN * 2,
  );
  const maxHeight = Math.max(MIN_HEIGHT, viewport.height - MARGIN * 2);
  const logMax = clamp(MIN_LOG, Math.round(viewport.height * LOG_RATIO), MAX_LOG);

  // Positioned once the real height is known -- and again when the fetch swaps
  // "Loading" for three rows, or the window changes size under it.
  const [style, setStyle] = useState<{
    left: number;
    top: number;
    visibility: "hidden" | "visible";
  }>({ left: anchor.left, top: anchor.bottom + GAP, visibility: "hidden" });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { height } = element.getBoundingClientRect();
    // Above the name when there isn't room under it, which is the common case
    // for the messages near the bottom of a busy channel. Either way the result
    // is clamped into the window: the anchor is a row inside a scroller, so it
    // can sit partly -- or entirely -- outside the visible area.
    const below = anchor.bottom + GAP;
    const preferred =
      below + height + MARGIN > viewport.height ? anchor.top - height - GAP : below;
    const lowest = Math.max(MARGIN, viewport.height - height - MARGIN);
    setStyle({
      left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(preferred, lowest)),
      visibility: "visible",
    });
  }, [anchor, card, error, viewport, width, logMax, theirs]);

  // Closed by an outside click, Escape or losing the window -- but not by
  // scrolling, unlike the context menu: the card has a scroller of its own, and
  // reading down someone's messages must not dismiss what you're reading.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: style.left, top: style.top, visibility: style.visibility, width, maxHeight }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-2xl shadow-black/60"
    >
      <div className="flex shrink-0 items-center gap-2.5 p-3">
        {card?.avatarUrl ? (
          <img
            src={card.avatarUrl}
            alt=""
            className="h-11 w-11 shrink-0 rounded-full object-cover"
          />
        ) : (
          // Their name's own color, so the card is recognizable before -- or
          // without -- an avatar.
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[16px] font-semibold"
            style={{ color }}
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" style={{ color }}>
            {displayName}
          </div>
          <div className="truncate text-[11px] text-ink-faint">@{login}</div>
        </div>
        {onCreateListener && (
          <button
            type="button"
            title="Create a listener tab for this user"
            aria-label="Create a listener tab for this user"
            onClick={onCreateListener}
            className="grid h-8 w-8 shrink-0 place-items-center self-start rounded-md text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 8.5a5.5 5.5 0 0 1 11 0c0 3.1-1.9 4.7-3.6 6.1-1.3 1.1-2.4 2-2.4 3.9a2 2 0 0 1-4 0" />
              <path d="M10 8.5a1.5 1.5 0 0 1 3 0c0 1.2-.8 1.8-1.7 2.5-.7.5-1.3 1.1-1.3 2" />
            </svg>
          </button>
        )}
      </div>

      <div className="shrink-0 space-y-1 border-t border-line px-3 py-2">
        {error && !card ? (
          <div className="text-[12px] text-ink-faint">{error}</div>
        ) : !card ? (
          <div className="text-[12px] text-ink-faint">Loading…</div>
        ) : (
          <>
            <Stat label="Account created">
              {card.createdAt ? (
                <Since iso={card.createdAt} />
              ) : (
                <span className="text-ink-faint">Unknown</span>
              )}
            </Stat>
            <Stat label="Following">
              {/* No history at all is a different claim from "doesn't follow",
                  and the service behind it is one that can simply be down. */}
              {!card.history ? (
                <span className="text-ink-faint">Unavailable</span>
              ) : card.history.followedAt ? (
                <Since iso={card.history.followedAt} />
              ) : (
                <span className="text-ink-faint">Not following</span>
              )}
            </Stat>
            <Stat label="Subscribed">
              {card.history ? (
                <SubLine history={card.history} />
              ) : (
                <span className="text-ink-faint">Unavailable</span>
              )}
            </Stat>
          </>
        )}
      </div>

      {/* The section that gives when the window is short: `min-h-0` is what
          lets the scroller below shrink past its own content, instead of
          pushing the card past `maxHeight`. */}
      <div className="flex min-h-0 flex-col border-t border-line">
        <div className="shrink-0 px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          In #{channel} this session
        </div>
        <div
          ref={log}
          style={{ maxHeight: logMax }}
          className="scroller min-h-0 overflow-y-auto px-3 pb-2"
        >
          {theirs.length === 0 ? (
            <div className="pb-1 text-[12px] text-ink-faint">Nothing yet.</div>
          ) : (
            theirs.map((message) => (
              <div key={message.key} className="flex gap-1.5 py-[2px] text-[12px] leading-[1.4]">
                <span className="w-8 shrink-0 pt-[1px] text-right text-[10px] tabular-nums text-ink-faint">
                  {timeOf(message.ts)}
                </span>
                <div className="selectable min-w-0 flex-1 break-words">
                  <MessageBody message={message} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
