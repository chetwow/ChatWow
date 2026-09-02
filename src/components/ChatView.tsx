import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { MessageRow, emoteAt, type EmoteTarget } from "./MessageRow";
import { Composer } from "./Composer";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import { UserCard, type UserCardTarget } from "./UserCard";
import { loginOf, useChat, type BlacklistKind } from "../store/chat";
import { messageLine, messageText } from "../lib/messageText";
import { imageKey, rulesMatching } from "../lib/emoteBlacklist";
import { ignoreForChannel, ignoreForUser, mentionIgnored } from "../lib/ignores";
import type { EmoteRule, StoredMessage } from "../types";

/** How close to the bottom still counts as "pinned". */
const PIN_THRESHOLD = 40;

export function ChatView({
  id,
  capturesTyping = true,
}: {
  /** The tab this view is of. Two tabs can be of one channel, so it's not the name. */
  id: string;
  /**
   * Whether this view's composer answers to typing anywhere in the window.
   * False in the pane you aren't working in: two composers both reclaiming
   * focus on every keystroke would take it in turns to steal your text.
   */
  capturesTyping?: boolean;
}) {
  const tab = useChat((state) => state.tabs.find((open) => open.id === id));
  const channel = tab?.channel ?? "";
  const account = tab?.account ?? "";
  // A mentions tab has no channel behind it and reads from its account's
  // cross-channel log instead. Everything below -- scroll pinning, the
  // context menu, user cards -- is the same view either way; only the source
  // and the composer differ.
  const isMentions = tab?.kind === "mentions";
  const channelMessages = useChat((state) => state.messages[id]);
  const mentionLog = useChat((state) => state.mentionLog[account]);
  const ready = useChat((state) => state.ready[id]);
  const tabs = useChat((state) => state.tabs);
  const setActive = useChat((state) => state.setActive);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    message: StoredMessage;
    emote: EmoteTarget | null;
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
  const personOptions = (message: StoredMessage): ContextMenuOption[] => {
    const login = message.login.toLowerCase();
    if (!login || message.kind === "notice") return [];
    if (myLogin && login === myLogin.toLowerCase()) return [];

    const name = message.displayName || login;
    const ignoring = mentionIgnores.includes(ignoreForUser(login));
    const blocked = blockedUsers.includes(login);

    return [
      { separator: true },
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
        ...personOptions(menu.message),
        ...(menu.emote ? emoteOptions(menu.emote) : []),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          // A right-click selects the word under it by default, which is the
          // browser preparing for a menu that isn't ours -- and it means every
          // right-click arrives with a selection, so Copy would offer that word
          // as "the selection" whether or not anyone chose it. Swallowed on the
          // way in, since the selection is made on mousedown, before the
          // `contextmenu` event the menu itself is opened from. A selection
          // made by dragging is untouched: preventing the default doesn't
          // clear one, it only stops a new one being made.
          onMouseDown={(event) => {
            if (event.button === 2) event.preventDefault();
          }}
          className="scroller h-full overflow-y-auto overflow-x-hidden py-2"
        >
          {!messages?.length && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-faint">
              <div className="text-[13px]">
                {isMentions
                  ? "Nothing addressed to you yet"
                  : ready
                    ? `Waiting for messages in #${channel}`
                    : `Connecting to #${channel}...`}
              </div>
              <div className="text-[11px]">
                {isMentions
                  ? "Mentions, replies and whispers from every channel land here."
                  : ready
                    ? "Quiet in here."
                    : "Loading emotes and badges."}
              </div>
            </div>
          )}

          <div ref={content}>
            {messages?.map((message) => (
              <MessageRow
                key={message.key}
                message={message}
                onContextMenu={openMenu}
                onNameClick={openCard}
                onChannelClick={isMentions ? goToChannel : undefined}
              />
            ))}
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
