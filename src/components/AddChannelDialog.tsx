import { useEffect, useRef, useState } from "react";
import { useChat } from "../store/chat";

const SUGGESTIONS = ["forsen", "xqc", "sodapoppin", "moistcr1tikal", "hasanabi"];

export function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const join = useChat((state) => state.join);
  const channels = useChat((state) => state.channels);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const submit = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      await join(trimmed);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const available = SUGGESTIONS.filter(
    (name) => !channels.includes(name) && name.includes(value.trim().toLowerCase()),
  );

  return (
    <div
      data-modal
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[18vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-[420px] overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <span className="text-[15px] text-ink-faint">#</span>
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit(value);
              if (event.key === "Escape") onClose();
            }}
            placeholder="Join a channel"
            spellCheck={false}
            autoComplete="off"
            className="selectable flex-1 bg-transparent py-3 text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          {busy && <span className="text-[11px] text-ink-faint">joining...</span>}
        </div>

        {error && (
          <div className="border-b border-line bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
            {error}
          </div>
        )}

        {available.length > 0 && (
          <div className="p-1">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Suggestions
            </div>
            {available.map((name) => (
              <button
                key={name}
                onClick={() => void submit(name)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
              >
                <span className="text-ink-faint">#</span>
                {name}
              </button>
            ))}
          </div>
        )}

        <div className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
          Press <kbd className="rounded bg-line px-1">Enter</kbd> to join,{" "}
          <kbd className="rounded bg-line px-1">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
