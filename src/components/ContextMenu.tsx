import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

export type ContextMenuOption =
  | { label: string; onSelect: (event: MouseEvent<HTMLButtonElement>) => void }
  /** A hairline rule, for grouping what the click landed *on* apart from the message. */
  | { separator: true }
  /**
   * A name for the group under it. For a menu that answers two questions at
   * once -- the tab's is "as whom?" and "with what behind it?" -- where the
   * rows alone don't say which is which and prefixing every one of them would.
   */
  | { heading: string };

/**
 * A minimal fixed-position menu, positioned at the (x, y) it's opened at and
 * clamped back on-screen once its size is known. Closes itself on an outside
 * click, Escape, or window blur -- callers just supply `options`.
 */
export function ContextMenu({
  x,
  y,
  options,
  onClose,
  onKeyDown,
  autoFocus = false,
  label,
}: {
  x: number;
  y: number;
  options: ContextMenuOption[];
  onClose: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  autoFocus?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const [style, setStyle] = useState<{ left: number; top: number; visibility: "hidden" | "visible" }>(
    { left: x, top: y, visibility: "hidden" },
  );

  useLayoutEffect(() => {
    // Opening the menu or choosing a panel does not select a menu action.
    if (autoFocus && style.visibility === "visible") ref.current?.focus({ preventScroll: true });
  }, [autoFocus, style.visibility]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setStyle({ left, top, visibility: "visible" });
  }, [x, y]);

  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (autoFocus && event.key === "Tab") setKeyboardNavigation(true);
      onKeyDown?.(event);
      if (autoFocus && event.defaultPrevented) {
        setKeyboardNavigation(false);
        ref.current?.focus({ preventScroll: true });
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, onKeyDown, autoFocus]);

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={autoFocus ? -1 : undefined}
      aria-label={label}
      data-menu=""
      onPointerMove={() => {
        if (!autoFocus || !keyboardNavigation) return;
        setKeyboardNavigation(false);
        ref.current?.focus({ preventScroll: true });
      }}
      style={{ left: style.left, top: style.top, visibility: style.visibility }}
      className="scroller fixed z-50 max-h-[calc(100vh-1rem)] min-w-[140px] overflow-y-auto rounded-lg border border-line bg-surface-raised py-1 shadow-2xl shadow-black/60 outline-none"
    >
      {options.map((option, index) =>
        "separator" in option ? (
          <div key={index} className="my-1 border-t border-line" />
        ) : "heading" in option ? (
          <div
            key={index}
            className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
          >
            {option.heading}
          </div>
        ) : (
          <button
            key={index}
            role="menuitem"
            onClick={(event) => {
              option.onSelect(event);
              onClose();
            }}
            className={`block w-full px-3 py-1.5 text-left text-[12px] text-ink-dim transition-colors ${
              autoFocus ? `outline-none ${keyboardNavigation ? "focus:bg-surface-hover focus:text-ink" : "hover:bg-surface-hover hover:text-ink"}`
                : "hover:bg-surface-hover hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ),
      )}
    </div>
  );
}
