import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dropdownNavigationIndex } from "../lib/dropdown";

/** A themed single-choice control. The popup escapes scroll containers but keeps the app theme. */
export function Dropdown<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, minWidth: 140 });
  const search = useRef({ text: "", time: 0 });
  const close = () => setOpen(false);
  const show = () => {
    trigger.current?.focus({ preventScroll: true });
    setActive(Math.max(0, options.findIndex((option) => option.id === value)));
    search.current = { text: "", time: 0 };
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const box = popup.current!.getBoundingClientRect();
    const width = Math.max(anchor.width, box.width);
    setPosition({
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, anchor.bottom + 4 + box.height <= window.innerHeight - 8
        ? anchor.bottom + 4 : anchor.top - box.height - 4),
      minWidth: anchor.width,
    });
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(trigger.current)) close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) popup.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return <>
    <button ref={trigger} type="button" role="combobox" aria-label={label}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined}
      onClick={() => open ? close() : show()} onBlur={close}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) show();
          else setActive((current) => dropdownNavigationIndex(event.key, current, options.length));
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (open) { onChange(options[active].id); close(); } else show();
        } else if (event.key === "Tab") close();
        else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          if (!open) show();
          const now = Date.now();
          const text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLowerCase();
          search.current = { text, time: now };
          const match = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
          if (match >= 0) setActive(match);
        }
      }}
      className="flex min-w-[140px] items-center justify-between gap-4 rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink outline-none transition-colors hover:bg-surface-hover focus-visible:border-accent"
    >
      {options.find((option) => option.id === value)?.label}
      <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true" className="shrink-0 text-ink-faint">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
    {open && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} data-menu=""
      style={position}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
      className="scroller fixed z-[60] max-h-[min(280px,calc(100vh-16px))] overflow-y-auto rounded-lg border border-line bg-surface-raised py-1 shadow-2xl shadow-black/60">
      {options.map((option, index) => <div key={option.id} id={`${id}-${index}`} role="option"
        aria-selected={option.id === value} onPointerMove={() => setActive(index)}
        onClick={() => { onChange(option.id); close(); trigger.current?.focus(); }}
        className={`flex cursor-default items-center justify-between gap-4 px-3 py-1.5 text-[12px] ${index === active ? "bg-surface-hover text-ink" : "text-ink-dim"}`}>
        {option.label}
        <span aria-hidden="true" className="w-3 text-accent">{option.id === value ? "✓" : ""}</span>
      </div>)}
    </div>, trigger.current?.closest("[data-theme]") ?? document.body)}
  </>;
}
