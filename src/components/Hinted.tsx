import type { ReactNode } from "react";

/**
 * A label with its explanation behind an info dot, shown on hover -- or on
 * focus, so it's reachable from the keyboard.
 *
 * The settings dialog's convention, shared with the account panel: the name of
 * a setting is usually enough on its own, and the reasoning waits behind the
 * dot rather than turning a panel into an essay.
 *
 * The whole thing is the trigger, children included, and it's focusable -- so
 * anything *clickable* has to stay outside it. Clicking a child focuses this
 * span (the browser walks up to the nearest focusable ancestor), which leaves
 * the tooltip pinned open until something else takes focus. Where the label
 * itself does something, pass no children and let the dot stand alone.
 */
export function Hinted({
  hint,
  className,
  children,
}: {
  hint: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      tabIndex={0}
      className={`group/hint relative inline-flex cursor-help items-center gap-1.5 outline-none ${className ?? ""}`}
    >
      {children}
      <svg viewBox="0 0 16 16" width="12" height="12" className="shrink-0 text-ink-faint">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
        <path d="M8 7.2v4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {/* Anchored under the label and clamped to the panel's width, so a long
          explanation can't push a scrollbar into the dialog.

          Case, weight and tracking are reset rather than merely unset: the
          label this hangs off can be styled, and a section heading's small
          caps were inherited straight into the sentence below it. A tooltip is
          prose wherever it's used. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-[min(260px,60vw)] rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-lg shadow-black/50 group-hover/hint:block group-focus/hint:block"
      >
        {hint}
      </span>
    </span>
  );
}
