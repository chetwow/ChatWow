/** Shared controls for both inline providers, outside the embedded player. */
export function InlinePlayerActions({ name, onOpenBrowser, onClose, closeLabel }: {
  name: string; closeLabel?: string; onOpenBrowser: () => void; onClose: () => void;
}) {
  const buttonClass = "grid h-6 w-6 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" className={buttonClass} onClick={onOpenBrowser} aria-label={`Open ${name} in browser`} title="Open in browser">
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
        </svg>
      </button>
      <button type="button" className={buttonClass} onClick={onClose} aria-label={closeLabel ?? `Close ${name} player`} title={closeLabel ?? "Close player"}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="m4 4 8 8m0-8-8 8" />
        </svg>
      </button>
    </span>
  );
}
