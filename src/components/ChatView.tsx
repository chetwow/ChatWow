import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { MessageRow, chatterNameAt, emoteAt, type EmoteTarget } from "./MessageRow";
import { Composer } from "./Composer";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import { UserCard, type UserCardTarget } from "./UserCard";
import { loginOf, useChat, type BlacklistKind } from "../store/chat";
import { messageLine, messageText } from "../lib/messageText";
import { imageKey, rulesMatching } from "../lib/emoteBlacklist";
import { ignoreForChannel, ignoreForUser, mentionIgnored, userBlocked } from "../lib/ignores";
import type { EmoteRule, StoredMessage } from "../types";

/** How close to the bottom still counts as "pinned". */
const PIN_THRESHOLD = 40;

/** The text visibly associated with a row, without fetching or re-resolving anything. */
function searchableText(message: StoredMessage, includeChannel: boolean): string {
  return [
    message.displayName,
    message.login,
    includeChannel ? message.channel : "",
    message.systemMessage,
    message.replyTo?.displayName,
    message.replyTo?.body,
    messageText(message),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
}

export function ChatView({
  id,
  capturesTyping = true,
  searchRequest = null,
  onCloseSearch,
}: {
  /** The tab this view is of. Two tabs can be of one channel, so it's not the name. */
  id: string;
  /**
   * Whether this view's composer answers to typing anywhere in the window.
   * False in the pane you aren't working in: two composers both reclaiming
   * focus on every keystroke would take it in turns to steal your text.
   */
  capturesTyping?: boolean;
  /** Non-null while this is the focused tab's active find target. */
  searchRequest?: number | null;
  onCloseSearch: () => void;
}) {
  const tab = useChat((state) => state.tabs.find((open) => open.id === id));
  const channel = tab?.channel ?? "";
  const account = tab?.account ?? "";
  // A mentions tab has no channel behind it and reads from its own filtered
  // cross-channel log instead. Everything below -- scroll pinning, the
  // context menu, user cards -- is the same view either way; only the source
  // and the composer differ.
  const isMentions = tab?.kind === "mentions";
  const channelMessages = useChat((state) => state.messages[id]);
  const mentionLog = useChat((state) => state.mentionLog[id]);
  const ready = useChat((state) => state.ready[id]);
  const tabs = useChat((state) => state.tabs);
  const setActive = useChat((state) => state.setActive);
  const openMentionsTab = useChat((state) => state.openMentionsTab);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    message: StoredMessage;
    emote: EmoteTarget | null;
    /** Only true when the right-click landed on the chatter-name button. */
    chatterName: boolean;
    /**
     * What was selected when the menu opened, if anything. Read then rather
     * than when Copy is clicked: pressing a menu button collapses the
     * selection, so by the time the handler runs there is nothing left to
     * read.
     */
    selection: string;
  } | null>(null);
  // Whether a copied line carries the time: what's on the clipboard should be
  // what was on the screen.
  const showTimestamps = useChat((state) => state.preferences.showTimestamps);
  const blacklist = useChat((state) => state.preferences.emoteBlacklist);
  const completeBlacklist = useChat((state) => state.preferences.emoteCompleteBlacklist);
  const addEmoteRule = useChat((state) => state.addEmoteRule);
  const removeEmoteRule = useChat((state) => state.removeEmoteRule);
  const mentionIgnores = useChat((state) => state.preferences.mentionIgnores);
  const blockedUsers = useChat((state) => state.preferences.blockedUsers);

  // Filtered here rather than dropped on the way in, for the reason the emote
  // blacklists are: adding a rule has to clear out what's already listed, and
  // taking one back has to bring it in again.
  const shown = useMemo(
    () => (mentionLog ?? []).filter((message) => !mentionIgnored(message, mentionIgnores)),
    [mentionLog, mentionIgnores],
  );
  const messages = isMentions ? shown : channelMessages;
  const setMentionIgnored = useChat((state) => state.setMentionIgnored);
  const setUserBlocked = useChat((state) => state.setUserBlocked);
  // Who "you" are here, which is this tab's account rather than the app's:
  // the same message can name you in one tab and nobody in the one beside it.
  const myLogin = useChat((state) => loginOf(state, account));
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [card, setCard] = useState<UserCardTarget | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const searchOpen = searchRequest !== null;
  const searchWasOpen = useRef(searchOpen);
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchMatches = useMemo(
    () =>
      normalizedSearch
        ? (messages ?? [])
            .filter((message) => !userBlocked(message, blockedUsers))
            .filter((message) => searchableText(message, isMentions).includes(normalizedSearch))
            .map((message) => message.key)
        : [],
    [messages, normalizedSearch, blockedUsers, isMentions],
  );
  const searchMatchIndex = useMemo(
    () => new Map(searchMatches.map((key, index) => [key, index])),
    [searchMatches],
  );

  // A repeated title-bar click or Ctrl/Cmd+F brings the field back even if
  // focus had moved into the transcript or composer.
  useLayoutEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [searchOpen, searchRequest]);

  useEffect(() => {
    setCurrentMatch((current) =>
      searchMatches.length === 0 ? 0 : Math.min(current, searchMatches.length - 1),
    );
  }, [searchMatches.length]);

  // Re-pin when switching tabs.
  useEffect(() => setPinned(true), [id]);
  // Drop any open reply/menu when switching tabs -- they refer to messages
  // that are about to scroll out from under them.
  useEffect(() => {
    setMenu(null);
    setReplyTo(null);
    setCard(null);
  }, [id]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, pinned, channel]);

  // Match wrappers carry a numeric index, so navigation never has to put an
  // arbitrary message key into a CSS selector. Finding moves away from the
  // live edge intentionally; incoming chat must not pull the result away.
  useLayoutEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const result = content.current?.querySelector<HTMLElement>(
      `[data-search-match="${currentMatch}"]`,
    );
    result?.scrollIntoView({ block: "center" });
    setPinned(false);
  }, [searchOpen, searchMatches, currentMatch]);

  // Keep the latest messages in view when the window (and so the scroller)
  // is resized -- without this, shrinking the window leaves scrollTop fixed
  // and the newest messages scroll out of sight even though we were pinned.
  //
  // The content wrapper is observed as well, because its height can grow
  // *after* the scroll above: rows are `content-visibility: auto` (see
  // styles.css), so one that's still below the fold measures at the
  // `contain-intrinsic-size` placeholder of a single line. A message that
  // wraps to three lines therefore lands short by the two lines the estimate
  // missed, and the newest message is left clipped by the bottom edge until
  // this correction runs against its real height.
  //
  // ResizeObserver fires repeatedly through a live drag, so the correction is
  // coalesced to at most once per animation frame rather than done on every
  // single notification. (Separately, live-resizing this window also shows a
  // brief stale/clipped frame -- that's an upstream Chromium/WebView2 resize
  // limitation on Windows, not related to this effect: tauri-apps/tauri#6322.)
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distance < PIN_THRESHOLD);
  };

  const jumpToPresent = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setPinned(true);
  };

  // Search deliberately unpins while visiting an older result. Closing it is
  // an equally deliberate return to live chat, whichever close control was
  // used (including the title-bar toggle outside this component).
  useLayoutEffect(() => {
    if (searchWasOpen.current && !searchOpen) jumpToPresent();
    searchWasOpen.current = searchOpen;
  }, [searchOpen]);

  // Stable identity: MessageRow is memoized to keep a busy channel cheap, and
  // a fresh callback on every render would defeat that for every row.
  const openMenu = useCallback((event: MouseEvent, message: StoredMessage) => {
    // The emote comes off the event's target rather than a prop: `MessageRow`
    // is memoized, so anything threaded down would cost the whole backlog a
    // re-render every time this callback's identity changed.
    setMenu({
      x: event.clientX,
      y: event.clientY,
      message,
      emote: emoteAt(event.target),
      chatterName: chatterNameAt(event.target),
      selection: (window.getSelection()?.toString() ?? "").trim(),
    });
  }, []);

  // Stable for the same reason `openMenu` is. The card hangs off the name's own
  // box rather than the pointer, so it lines up with what was clicked however
  // the row happens to wrap.
  const openCard = useCallback((event: MouseEvent, message: StoredMessage) => {
    setCard({
      login: message.login,
      displayName: message.displayName,
      color: message.color,
      // The message's own channel, not the view's: in the mentions tab those
      // differ, and the follow and subscription lines are about the channel
      // the message was said in.
      channel: message.channel,
      anchor: event.currentTarget.getBoundingClientRect(),
    });
  }, []);
  const closeCard = useCallback(() => setCard(null), []);

  // The chip on a mentions-tab row: go to where it was said. A channel you've
  // since left has nothing to switch to, so it stays put rather than
  // selecting a tab that isn't there.
  const goToChannel = useCallback(
    (target: string) => {
      // The same account's tab on it, since that's the one holding the copy of
      // the message you just clicked; failing that, anyone's.
      const mine = tabs.find(
        (open) => open.kind === "channel" && open.channel === target && open.account === account,
      );
      const any = mine ?? tabs.find((open) => open.kind === "channel" && open.channel === target);
      if (any) setActive(any.id);
    },
    [tabs, account, setActive],
  );

  /**
   * The blacklist half of the menu, appended below Copy/Reply so an emote-heavy
   * message doesn't lose its ordinary actions. Removals are listed per matching
   * rule, and say which rule they'd drop -- an emote hidden by id under an alias
   * you don't recognize is otherwise unexplainable from chat alone.
   */
  const emoteOptions = (emote: EmoteTarget): ContextMenuOption[] => {
    const remove = (list: BlacklistKind, rules: EmoteRule[], suffix: string) =>
      rules.map((rule) => ({
        label:
          rule.kind === "name"
            ? `Remove name "${rule.value}" from ${suffix}`
            : `Remove id from ${suffix}`,
        onSelect: () => removeEmoteRule(list, rule),
      }));

    const hiding = rulesMatching(emote, blacklist);
    const completing = rulesMatching(emote, completeBlacklist);

    return [
      { separator: true },
      ...(hiding.length
        ? remove("emoteBlacklist", hiding, "blacklist")
        : [
            {
              label: "Blacklist emote by name",
              onSelect: () =>
                addEmoteRule("emoteBlacklist", { kind: "name", value: emote.name }),
            },
            {
              label: "Blacklist emote by id",
              onSelect: () =>
                addEmoteRule("emoteBlacklist", { kind: "id", value: imageKey(emote) }),
            },
          ]),
      ...(completing.length
        ? remove("emoteCompleteBlacklist", completing, "autocomplete blacklist")
        : [
            {
              // By name: what autocomplete matches on is what you type, and
              // it's the single-letter aliases that make it worth doing.
              label: "Blacklist emote from autocomplete",
              onSelect: () =>
                addEmoteRule("emoteCompleteBlacklist", { kind: "name", value: emote.name }),
            },
          ]),
    ];
  };

  /**
   * The two ways to hear less from someone, offered on their message rather
   * than buried in settings -- which is where you are when you decide. Not on
   * your own messages, and not on notices, which have no author.
   */
  const personOptions = (message: StoredMessage, onName: boolean): ContextMenuOption[] => {
    const login = message.login.toLowerCase();
    if (!login || message.kind === "notice") return [];
    if (myLogin && login === myLogin.toLowerCase()) return [];

    const name = message.displayName || login;
    const ignoring = mentionIgnores.includes(ignoreForUser(login));
    const blocked = blockedUsers.includes(login);

    return [
      { separator: true },
      ...(onName && message.kind !== "whisper" && message.channel
        ? [
            {
              label: "Create listener tab for this user",
              onSelect: () =>
                void openMentionsTab(
                  {
                    name,
                    accounts: [],
                    users: [login],
                    channels: [message.channel],
                    phrases: [],
                    notify: false,
                  },
                  { seedCurrentMatches: true },
                ),
            },
          ]
        : []),
      {
        label: ignoring ? `Hear mentions from ${name} again` : `Ignore mentions from ${name}`,
        onSelect: () => setMentionIgnored(ignoreForUser(login), !ignoring),
      },
      {
        label: blocked ? `Unblock ${name}` : `Block ${name}`,
        onSelect: () => setUserBlocked(login, !blocked),
      },
      // Only where several channels are mixed together: in a channel's own
      // view the room you'd be silencing is the one you're reading.
      ...(isMentions && message.kind !== "whisper" && message.channel
        ? [
            {
              label: mentionIgnores.includes(ignoreForChannel(message.channel))
                ? `Hear mentions in #${message.channel} again`
                : `Ignore mentions in #${message.channel}`,
              onSelect: () =>
                setMentionIgnored(
                  ignoreForChannel(message.channel),
                  !mentionIgnores.includes(ignoreForChannel(message.channel)),
                ),
            },
          ]
        : []),
    ];
  };

  const menuOptions: ContextMenuOption[] = menu
    ? [
        {
          // Selecting part of a message and then copying the whole thing is
          // never what was meant, so a selection wins -- and the label says so,
          // since the two are a click apart and the difference is invisible
          // once it's on the clipboard.
          label: menu.selection ? "Copy selection" : "Copy",
          onSelect: () => {
            void navigator.clipboard.writeText(
              menu.selection || (menu.message.systemMessage ?? messageText(menu.message)),
            );
          },
        },
        {
          // The same text as it reads on screen: who said it, and the time if
          // the reader has timestamps on.
          label: "Copy message",
          onSelect: () => {
            void navigator.clipboard.writeText(messageLine(menu.message, showTimestamps));
          },
        },
        // No composer in the mentions tab, so there'd be nowhere for the reply
        // to go -- the row's channel chip is the way back to one.
        ...(menu.message.kind === "chat" && !isMentions
          ? [{ label: "Reply", onSelect: () => setReplyTo(menu.message) }]
          : []),
        ...personOptions(menu.message, menu.chatterName),
        ...(menu.emote ? emoteOptions(menu.emote) : []),
      ]
    : [];

  const moveSearch = (direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    setCurrentMatch(
      (current) => (current + direction + searchMatches.length) % searchMatches.length,
    );
  };

  const searchStatus = !normalizedSearch
    ? ""
    : searchMatches.length === 0
      ? "No matches"
      : `${currentMatch + 1} of ${searchMatches.length}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-surface-raised px-2 py-1.5">
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            className="shrink-0 text-ink-faint"
          >
            <circle cx="6.8" cy="6.8" r="4.2" />
            <path d="m10 10 3.5 3.5" strokeLinecap="round" />
          </svg>
          <input
            ref={searchInput}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setCurrentMatch(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCloseSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                moveSearch(event.shiftKey ? -1 : 1);
              }
            }}
            aria-label="Search messages in active tab"
            placeholder="Search messages"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="selectable min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <span className="w-16 shrink-0 whitespace-nowrap text-center text-[10px] tabular-nums text-ink-faint">
            {searchStatus}
          </span>
          <button
            onClick={() => moveSearch(-1)}
            disabled={searchMatches.length === 0}
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-30"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 10 4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => moveSearch(1)}
            disabled={searchMatches.length === 0}
            aria-label="Next match"
            title="Next match (Enter)"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-30"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={onCloseSearch}
            aria-label="Close search"
            title="Close search (Escape)"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m3.5 3.5 9 9m0-9-9 9" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="scroller h-full overflow-y-auto overflow-x-hidden py-2"
        >
          {!messages?.length && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-faint">
              <div className="text-[13px]">
                {isMentions
                  ? "No matching messages yet"
                  : ready
                    ? `Waiting for messages in #${channel}`
                    : `Connecting to #${channel}...`}
              </div>
              <div className="text-[11px]">
                {isMentions
                  ? "Matches from the selected open channels land here."
                  : ready
                    ? "Quiet in here."
                    : "Loading emotes and badges."}
              </div>
            </div>
          )}

          <div ref={content}>
            {messages?.map((message) => {
              const match = searchMatchIndex.get(message.key);
              return (
                <div key={message.key} data-search-match={match}>
                  <MessageRow
                    message={message}
                    onContextMenu={openMenu}
                    onNameClick={openCard}
                    onChannelClick={isMentions ? goToChannel : undefined}
                    listenerMatch={isMentions}
                    searchMatch={
                      !searchOpen || match === undefined
                        ? undefined
                        : match === currentMatch
                          ? "current"
                          : "match"
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        {!pinned && (
          <button
            onClick={jumpToPresent}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg shadow-black/40 transition hover:bg-accent-dim"
          >
            Jump to present
          </button>
        )}

        {menu && (
          <ContextMenu x={menu.x} y={menu.y} options={menuOptions} onClose={() => setMenu(null)} />
        )}

        {/* Keyed by who it's about: clicking a second name reuses this slot, and
            without a key the card would keep the first person's fetched data. */}
        {card && (
          <UserCard key={`${card.channel}|${card.login}`} target={card} onClose={closeCard} />
        )}
      </div>

      {/* Nothing to send to: the mentions tab spans every channel, so there's
          no one room a message typed here would belong to. */}
      {!isMentions && (
        <Composer
          id={id}
          capturesTyping={capturesTyping}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      )}
    </div>
  );
}
