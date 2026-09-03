import { useEffect, useRef, useState, type FormEvent } from "react";
import { TITLE_BAR_PX } from "../lib/tauri";
import { useChat } from "../store/chat";

/** Rename a listener without changing its filter or collected messages. */
export function RenameListenerDialog({
  tabId,
  currentName,
  onClose,
}: {
  tabId: string;
  currentName: string;
  onClose: () => void;
}) {
  const rename = useChat((state) => state.renameMentionsTab);
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.select(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return setError("Give the tab a name.");
    setBusy(true);
    setError(null);
    try {
      await rename(tabId, clean);
      onClose();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-[70] flex items-start justify-center bg-black/60 px-4 pt-[22vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-listener-title"
        onSubmit={(event) => void submit(event)}
        onClick={(event) => event.stopPropagation()}
        className="w-[min(360px,100%)] rounded-xl border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60"
      >
        <h2 id="rename-listener-title" className="text-[14px] font-semibold text-ink">
          Rename tab
        </h2>
        <label className="mt-3 block">
          <span className="mb-1 block text-[11px] text-ink-faint">Tab name</span>
          <input
            ref={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            className="selectable w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          />
        </label>
        {error && <div className="mt-2 text-[11px] text-rose-300">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-40"
          >
            {busy ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}
