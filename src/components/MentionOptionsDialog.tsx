import { useEffect } from "react";
import { TITLE_BAR_PX } from "../lib/tauri";
import { mentionTabName, useChat } from "../store/chat";
import { MentionFilterEditor } from "./MentionFilterEditor";

/** Edit every persisted setting owned by one custom mentions listener. */
export function MentionOptionsDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const tab = useChat((state) => state.tabs.find((candidate) => candidate.id === tabId));
  const tabs = useChat((state) => state.tabs);
  const accounts = useChat((state) => state.auth.accounts);
  const update = useChat((state) => state.updateMentionsTab);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!tab?.mention) return null;
  // Keep currently configured rooms visible even after their final source tab
  // closes, so opening Options for an unrelated edit cannot silently drop
  // them. Reopening one resumes the listener as before.
  const channels = [
    ...new Set([
      ...tabs.filter((candidate) => candidate.kind === "channel").map(({ channel }) => channel),
      ...tab.mention.channels,
    ]),
  ];

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-[70] flex items-start justify-center bg-black/60 px-4 py-[8vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mention-options-title"
        onClick={(event) => event.stopPropagation()}
        className="max-h-full w-[min(430px,100%)] overflow-y-auto rounded-xl border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60"
      >
        <h2 id="mention-options-title" className="text-[14px] font-semibold text-ink">
          Listener options
        </h2>
        <p className="mb-4 mt-1 text-[11px] text-ink-faint">{mentionTabName(tab)}</p>
        <MentionFilterEditor
          initial={tab.mention}
          accounts={accounts}
          channels={channels}
          submitLabel="Save"
          busyLabel="Saving…"
          autoFocusName
          onCancel={onClose}
          onSave={async (mention) => {
            await update(tabId, mention);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
