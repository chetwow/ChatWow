import { useEffect, useRef, useState } from "react";
import { useChat } from "../store/chat";
import { api } from "../lib/api";
import { IS_TAURI, TITLE_BAR_PX } from "../lib/tauri";
import { ANONYMOUS, type ChannelHit } from "../types";

/** Wait this long after the last keystroke before asking Twitch. */
const DEBOUNCE_MS = 250;
/**
 * Below this, search isn't worth a request: one character returns near-random
 * relevance ordering, and anyone who knows the channel is about to type more.
 */
const MIN_QUERY = 2;

/**
 * Mock mode has no backend to invoke. The import stays dynamic so the sample
 * data never reaches a production bundle.
 */
async function searchChannels(query: string): Promise<ChannelHit[]> {
  if (!IS_TAURI) {
    const { mockSearchChannels } = await import("../dev/mockData");
    return mockSearchChannels(query);
  }
  return api.searchChannels(query);
}

function LiveDot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />;
}

function Suggestion({
  hit,
  joined,
  active,
  onHover,
  onPick,
}: {
  hit: ChannelHit;
  joined: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={joined}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        joined ? "cursor-default opacity-50" : active ? "bg-surface-hover" : "",
      ].join(" ")}
    >
      {hit.thumbnailUrl ? (
        <img
          src={hit.thumbnailUrl}
          alt=""
          loading="lazy"
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="h-6 w-6 shrink-0 rounded-full bg-line" />
      )}

      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{hit.displayName}</span>

      {hit.isLive && !joined && (
        <span className="flex min-w-0 shrink items-center gap-1.5 text-[11px] text-ink-faint">
          <LiveDot />
          <span className="truncate">{hit.gameName || "Live"}</span>
        </span>
      )}
      {joined && <span className="shrink-0 text-[10px] text-ink-faint">joined</span>}
    </button>
  );
}

export function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const openTab = useChat((state) => state.openTab);
  const tabs = useChat((state) => state.tabs);
  const accounts = useChat((state) => state.auth.accounts);
  const defaultAccount = useChat((state) => state.auth.defaultAccount);
  const loggedIn = accounts.length > 0;
  /**
   * Which account the tab about to be opened will read as. Starts at the one
   * new tabs are set to use; picking another here is how you open a channel
   * you already have open -- as somebody else.
   */
  const [account, setAccount] = useState(defaultAccount);
  const openTabs = tabs.filter((tab) => tab.account === account);
  const joinedChannels = openTabs.map((tab) => tab.channel);
  const hasMentions = openTabs.some((tab) => tab.kind === "mentions");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<ChannelHit[]>([]);
  const [searching, setSearching] = useState(false);
  /** -1 means "join exactly what's typed" -- the arrow keys step into the list. */
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  /** Only the newest search may write results; earlier ones land out of order. */
  const request = useRef(0);

  useEffect(() => input.current?.focus(), []);

  const query = value.trim();
  const canSearch = IS_TAURI ? loggedIn : true;

  /**
   * The other kind of tab, offered here because this is the dialog you reach
   * for when you want one. Only while the input is empty: once you're typing a
   * channel name it's in the way, and the search results take the space.
   */
  const offerMentions = !hasMentions && query.length === 0;

  const openMentions = () => {
    void openTab("mentions", "", account);
    onClose();
  };

  useEffect(() => {
    setActive(-1);
    if (!canSearch || query.length < MIN_QUERY) {
      setHits([]);
      setSearching(false);
      return;
    }

    const ticket = ++request.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchChannels(query);
        if (ticket === request.current) setHits(found);
      } catch {
        // A failed search shouldn't take over the dialog -- you can still type
        // a name and press Enter, which is the path that never needed Twitch.
        if (ticket === request.current) setHits([]);
      } finally {
        if (ticket === request.current) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, canSearch]);

  /**
   * Next selectable row, wrapping back through -1 so the text you typed is
   * always reachable. Channels you're already in are skipped: they're disabled,
   * so landing on one would highlight nothing and look like a dead keypress.
   * Returns -1 if every hit is already joined.
   */
  const step = (from: number, direction: 1 | -1): number => {
    let next = from;
    for (let i = 0; i <= hits.length; i++) {
      next += direction;
      if (next >= hits.length) next = -1;
      else if (next < -1) next = hits.length - 1;
      if (next === -1 || !joinedChannels.includes(hits[next].login)) return next;
    }
    return -1;
  };

  const submit = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      await openTab("channel", trimmed, account);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") return onClose();

    if (event.key === "Enter") {
      // Nothing typed and the mentions row on offer: it's the only thing on
      // screen to take, and Enter on an empty box otherwise does nothing.
      if (offerMentions) return openMentions();
      const hit = active >= 0 ? hits[active] : null;
      return void submit(hit ? hit.login : value);
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      setActive(step(active, event.key === "ArrowDown" ? 1 : -1));
    }
  };

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[18vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-[min(420px,100%)] overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <span className="text-[15px] text-ink-faint">#</span>
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Join a channel"
            spellCheck={false}
            autoComplete="off"
            className="selectable flex-1 bg-transparent py-3 text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          {busy ? (
            <span className="text-[11px] text-ink-faint">joining...</span>
          ) : (
            searching && <span className="text-[11px] text-ink-faint">searching...</span>
          )}
        </div>

        {error && (
          <div className="border-b border-line bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
            {error}
          </div>
        )}

        {offerMentions && (
          <div className="p-1">
            <button
              type="button"
              onClick={openMentions}
              className="flex w-full items-center gap-2 rounded-md bg-surface-hover px-2 py-1.5 text-left"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-rose-400/15 text-[12px] font-semibold text-rose-300">
                @
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">Mentions</span>
                <span className="block truncate text-[11px] text-ink-faint">
                  Every mention, reply and whisper, from all channels at once
                </span>
              </span>
            </button>
          </div>
        )}

        {hits.length > 0 && (
          <div className="scroller max-h-[260px] overflow-y-auto p-1">
            {hits.map((hit, index) => (
              <Suggestion
                key={hit.login}
                hit={hit}
                joined={joinedChannels.includes(hit.login)}
                active={index === active}
                onHover={() => setActive(index)}
                onPick={() => void submit(hit.login)}
              />
            ))}
          </div>
        )}

        {/* Which account the new tab reads as. Only worth a row when there's
            more than one answer -- and it's what makes opening a channel you
            already have open a sensible thing to do rather than a duplicate. */}
        {accounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-t border-line px-3 py-2">
            <span className="mr-1 text-[11px] text-ink-faint">Join as</span>
            {[...accounts.map((held) => ({ id: held.id, label: held.login })), {
              id: ANONYMOUS,
              label: "anonymous",
            }].map((choice) => (
              <button
                key={choice.id || "anon"}
                type="button"
                onClick={() => setAccount(choice.id)}
                className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                  account === choice.id
                    ? "bg-accent/20 text-accent"
                    : "text-ink-dim hover:bg-surface-hover hover:text-ink"
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
          {offerMentions ? (
            <>
              Press <kbd className="rounded bg-line px-1">Enter</kbd> for a mentions tab, or type a
              channel name
            </>
          ) : !canSearch ? (
            // Helix has no unauthenticated channel search, so this is a real
            // limit rather than something to paper over -- but typing a name
            // still works, which is worth saying in the same breath.
            <>Sign in to search channels, or type a name and press Enter</>
          ) : (
            <>
              Press <kbd className="rounded bg-line px-1">Enter</kbd> to join,{" "}
              <kbd className="rounded bg-line px-1">Esc</kbd> to close
            </>
          )}
        </div>
      </div>
    </div>
  );
}
