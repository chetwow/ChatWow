import { useEffect, useRef, useState, type FormEvent } from "react";
import { TITLE_BAR_PX } from "../lib/tauri";
import {
  MAX_TIMEOUT_SECONDS,
  TIMEOUT_UNITS,
  timeoutParts,
  timeoutSeconds,
  type TimeoutUnit,
  validTimeout,
} from "../lib/timeout";

export type TimeoutTarget = {
  tabId: string;
  login: string;
  displayName: string;
};

/** An arbitrary timeout length, kept explicit so a bare number is never ambiguous. */
export function TimeoutDialog({
  target,
  initialSeconds,
  onSubmit,
  onClose,
}: {
  target: TimeoutTarget;
  initialSeconds: number;
  onSubmit: (seconds: number) => Promise<void>;
  onClose: () => void;
}) {
  const initial = timeoutParts(initialSeconds);
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState<TimeoutUnit>(initial.unit);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.select(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    const seconds = timeoutSeconds(value, unit);
    if (!Number.isInteger(value) || value < 1 || !validTimeout(seconds)) {
      return setError(
        `Enter a whole-number duration no longer than 2 weeks (${MAX_TIMEOUT_SECONDS.toLocaleString()} seconds).`,
      );
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit(seconds);
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
      className="fixed inset-x-0 bottom-0 z-[80] flex items-start justify-center bg-black/60 px-4 pt-[22vh] backdrop-blur-[2px]"
      onClick={() => !busy && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="timeout-title"
        onSubmit={(event) => void submit(event)}
        onClick={(event) => event.stopPropagation()}
        className="w-[min(380px,100%)] rounded-xl border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60"
      >
        <h2 id="timeout-title" className="text-[14px] font-semibold text-ink">
          Time out @{target.displayName}
        </h2>
        <div className="mt-3 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-ink-faint">Duration</span>
            <input
              ref={input}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="selectable w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="w-32 shrink-0">
            <span className="mb-1 block text-[11px] text-ink-faint">Unit</span>
            <select
              value={unit}
              onChange={(event) => setUnit(event.target.value as TimeoutUnit)}
              className="w-full appearance-none rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {TIMEOUT_UNITS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="mt-2 text-[11px] text-rose-300">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !amount}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-40"
          >
            {busy ? "Timing out…" : "Time out"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Direct menu actions have no form to hold a Twitch error, so give them one small dialog. */
export function ModerationErrorDialog({ error, onClose }: { error: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-[80] flex items-start justify-center bg-black/60 px-4 pt-[22vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="moderation-error-title"
        onClick={(event) => event.stopPropagation()}
        className="w-[min(380px,100%)] rounded-xl border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60"
      >
        <h2 id="moderation-error-title" className="text-[14px] font-semibold text-ink">
          Moderation failed
        </h2>
        <p className="mt-2 break-words text-[12px] text-rose-300">{error}</p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
