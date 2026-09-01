import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { MessageRow, emoteAt, type EmoteTarget } from "./MessageRow";
import { Composer } from "./Composer";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import { useChat, type BlacklistKind } from "../store/chat";
import { messageText } from "../lib/messageText";
import { imageKey, rulesMatching } from "../lib/emoteBlacklist";
import type { EmoteRule, StoredMessage } from "../types";

/** How close to the bottom still counts as "pinned". */
const PIN_THRESHOLD = 40;

export function ChatView({ channel }: { channel: string }) {
  const messages = useChat((state) => state.messages[channel]);
  const ready = useChat((state) => state.ready[channel]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [menu, setMenu] = useState<
    { x: number; y: number; message: StoredMessage; emote: EmoteTarget | null } | null
  >(null);
  const blacklist = useChat((state) => state.preferences.emoteBlacklist);
  const completeBlacklist = useChat((state) => state.preferences.emoteCompleteBlacklist);
  const addEmoteRule = useChat((state) => state.addEmoteRule);
  const removeEmoteRule = useChat((state) => state.removeEmoteRule);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);

  // Re-pin when switching channels.
  useEffect(() => setPinned(true), [channel]);
  // Drop any open reply/menu when switching channels -- they refer to messages
  // that are about to scroll out from under them.
  useEffect(() => {
    setMenu(null);
    setReplyTo(null);
  }, [channel]);

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
    setMenu({ x: event.clientX, y: event.clientY, message, emote: emoteAt(event.target) });
  }, []);

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

  const menuOptions: ContextMenuOption[] = menu
    ? [
        {
          label: "Copy",
          onSelect: () => {
            void navigator.clipboard.writeText(menu.message.systemMessage ?? messageText(menu.message));
          },
        },
        ...(menu.message.kind === "chat"
          ? [{ label: "Reply", onSelect: () => setReplyTo(menu.message) }]
          : []),
        ...(menu.emote ? emoteOptions(menu.emote) : []),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="scroller h-full overflow-y-auto overflow-x-hidden py-2"
        >
          {!messages?.length && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-faint">
              <div className="text-[13px]">
                {ready ? `Waiting for messages in #${channel}` : `Connecting to #${channel}...`}
              </div>
              <div className="text-[11px]">
                {ready ? "Quiet in here." : "Loading emotes and badges."}
              </div>
            </div>
          )}

          <div ref={content}>
            {messages?.map((message) => (
              <MessageRow key={message.key} message={message} onContextMenu={openMenu} />
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
      </div>

      <Composer channel={channel} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
    </div>
  );
}
