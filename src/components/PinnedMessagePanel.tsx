import { tabPin, useChat } from "../store/chat";
import { MessageBody } from "./MessageRow";

/** Outside the timeline so the pin stays below the tabs while chat scrolls. */
export function PinnedMessagePanel({ tabId }: { tabId: string }) {
  const pin = useChat((state) => tabPin(state, tabId));
  const dismissed = useChat((state) => state.dismissedPins[tabId]);
  const dismiss = useChat((state) => state.dismissPinnedMessage);
  if (!pin || pin.id === dismissed) return null;

  return (
    <section
      aria-label="Pinned message"
      className="relative shrink-0 border-b border-line bg-accent/5 px-3 py-2"
    >
      <div className="mb-1 flex items-center gap-1.5 pr-6 text-[10px] font-semibold text-ink-dim">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="m5 2 7 7M6 3 3 7l3 1 2 3 4-3M6 8l-4 6"
            stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span data-tooltip={pin.pinnedBy ? `Pinned by ${pin.pinnedBy}` : undefined}>Pinned message</span>
      </div>
      <button
        type="button"
        aria-label="Dismiss pinned message"
        data-tooltip="Dismiss pinned message"
        onClick={() => dismiss(tabId)}
        className="absolute right-1.5 top-1 grid h-6 w-6 place-items-center rounded text-ink-dim hover:bg-surface-hover hover:text-ink focus-visible:outline-accent"
      >
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
          <path d="m1 1 8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <div
        className="selectable max-h-32 overflow-y-auto pr-1 leading-relaxed text-ink [overflow-wrap:anywhere]"
        style={{ fontSize: "var(--chat-font-size)" }}
      >
        <span className="font-semibold" style={{ color: pin.message.color }}>
          {pin.message.displayName || pin.message.login}
        </span>
        {": "}
        <MessageBody message={pin.message} />
      </div>
    </section>
  );
}
