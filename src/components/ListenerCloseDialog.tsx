import { useEffect, useState } from "react";
import { TITLE_BAR_PX } from "../lib/tauri";
import { useChat } from "../store/chat";

/** Confirms closing the final channel tab that feeds one or more listeners. */
export function ListenerCloseDialog() {
  const warning = useChat((state) => state.listenerCloseWarning);
  const cancel = useChat((state) => state.cancelListenerClose);
  const confirm = useChat((state) => state.confirmListenerClose);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => setDontShowAgain(false), [warning?.tabId]);
  useEffect(() => {
    if (!warning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [warning, cancel]);

  if (!warning) return null;
  const labels = warning.listeners.map((listener) => `“${listener}”`).join(", ");
  const plural = warning.listeners.length > 1;

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-[70] flex items-start justify-center bg-black/60 px-4 pt-[22vh] backdrop-blur-[2px]"
      onClick={cancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="listener-close-title"
        onClick={(event) => event.stopPropagation()}
        className="w-[min(420px,100%)] rounded-xl border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60"
      >
        <h2 id="listener-close-title" className="text-[14px] font-semibold text-ink">
          Stop listening to #{warning.channel}?
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
          Closing this tab stops {labels} from receiving messages from #{warning.channel}. The
          mentions {plural ? "tabs" : "tab"} will stay open.
        </p>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-[11px] text-ink-dim">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(event) => setDontShowAgain(event.target.checked)}
            className="accent-accent"
          />
          Do not show this warning in the future
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            autoFocus
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm(dontShowAgain)}
            className="rounded-md bg-rose-500 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-rose-400"
          >
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
