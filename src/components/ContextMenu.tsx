import { useLayoutEffect, useRef, useState } from "react";

export type ContextMenuOption =
  | { label: string; onSelect: () => void }
  /** A hairline rule, for grouping what the click landed *on* apart from the message. */
  | { separator: true };

/**
 * A minimal fixed-position menu, positioned at the (x, y) it's opened at and
 * clamped back on-screen once its size is known. Closes itself on an outside
 * click, Escape, window blur, or scroll -- callers just supply `options`.
 */
export function ContextMenu({
  x,
  y,
  options,
  closeOnScroll = true,
  onClose,
}: {
  x: number;
  y: number;
  options: ContextMenuOption[];
  /**
   * Whether a scroll anywhere closes the menu. True for a menu opened *on*
   * something, which slides out from under it. False for one belonging to a
   * fixed control: chat scrolls on its own every time a message lands, and a
   * menu that closed on that would be unopenable in a busy channel.
   */
  closeOnScroll?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ left: number; top: number; visibility: "hidden" | "visible" }>(
    { left: x, top: y, visibility: "hidden" },
  );

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    if (closeOnScroll) window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, closeOnScroll]);

  return (
    <div
      ref={ref}
      style={{ left: style.left, top: style.top, visibility: style.visibility }}
      className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-line bg-surface-raised py-1 shadow-2xl shadow-black/60"
    >
      {options.map((option, index) =>
        "separator" in option ? (
          <div key={index} className="my-1 border-t border-line" />
        ) : (
          <button
            key={index}
            onClick={() => {
              option.onSelect();
              onClose();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            {option.label}
          </button>
        ),
      )}
    </div>
  );
}
