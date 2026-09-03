import { useEffect, useRef } from "react";
import type { ChatterMatch } from "../lib/chatterComplete";

function Row({
  chatter,
  selected,
  onHover,
  onPick,
}: {
  chatter: ChatterMatch;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const row = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const distinctLogin = chatter.name.toLocaleLowerCase() !== chatter.login;

  return (
    <button
      ref={row}
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        "flex w-full items-baseline gap-2 px-2 py-1.5 text-left transition-colors",
        selected ? "bg-accent/25" : "hover:bg-surface-hover",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">@{chatter.name}</span>
      {distinctLogin && (
        <span className="shrink-0 text-[10px] text-ink-faint">@{chatter.login}</span>
      )}
    </button>
  );
}

/** Shared username suggestions for the composer and listener editor. */
export function ChatterPicker({
  matches,
  selected,
  placement,
  onSelect,
  onPick,
}: {
  matches: ChatterMatch[];
  selected: number;
  placement: "above" | "below";
  onSelect: (index: number) => void;
  onPick: (chatter: ChatterMatch) => void;
}) {
  const position =
    placement === "above"
      ? "absolute bottom-full left-2 z-50 mb-1 w-[280px] max-w-[calc(100%-1rem)]"
      : "absolute left-0 right-0 top-full z-[80] mt-1";

  return (
    <div
      role="listbox"
      aria-label="Username suggestions"
      className={`${position} overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl shadow-black/50`}
    >
      <div className="scroller max-h-[220px] overflow-y-auto py-1">
        {matches.map((chatter, index) => (
          <Row
            key={chatter.login}
            chatter={chatter}
            selected={index === selected}
            onHover={() => onSelect(index)}
            onPick={() => onPick(chatter)}
          />
        ))}
      </div>
    </div>
  );
}
