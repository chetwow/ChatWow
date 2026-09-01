import { useEffect, useRef } from "react";
import { EmoteImage } from "./EmoteImage";
import type { PickerItem } from "../lib/emoteComplete";

const PROVIDER_LABEL: Record<string, string> = {
  twitch: "Twitch Emote",
  "7tv": "7TV Emote",
};

function Row({
  item,
  selected,
  onHover,
  onPick,
}: {
  item: PickerItem;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const row = useRef<HTMLButtonElement>(null);

  // Keep the keyboard selection visible as it moves past either edge.
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const label = item.kind === "emote" ? (PROVIDER_LABEL[item.entry.provider] ?? item.entry.provider) : "Emoji";
  const name = item.kind === "emote" ? item.entry.name : item.emoji.n;

  return (
    <button
      ref={row}
      type="button"
      // Mouse-down would take focus off the composer before the click lands,
      // which closes the picker out from under the pick.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        "flex w-full items-center gap-2 px-2 py-1 text-left transition-colors",
        selected ? "bg-accent/25" : "hover:bg-surface-hover",
      ].join(" ")}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        {item.kind === "emote" ? (
          <EmoteImage
            id={item.entry.id}
            provider={item.entry.provider}
            url={item.entry.url}
            name={item.entry.name}
            className="max-h-7 max-w-7 object-contain"
          />
        ) : (
          <span className="text-[20px] leading-none">{item.emoji.c}</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
      <span className="shrink-0 text-[10px] text-ink-faint">{label}</span>
    </button>
  );
}

/**
 * The `:` emote search, floating above the composer. Purely presentational --
 * the composer owns the query, the selection and every key that drives them.
 */
export function EmotePicker({
  items,
  selected,
  onSelect,
  onPick,
}: {
  items: PickerItem[];
  selected: number;
  onSelect: (index: number) => void;
  onPick: (item: PickerItem) => void;
}) {
  return (
    <div className="absolute bottom-full left-2 right-2 z-50 mb-1 w-[320px] max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl shadow-black/50">
      <div className="scroller max-h-[248px] overflow-y-auto py-1">
        {items.map((item, index) => (
          <Row
            key={item.kind === "emote" ? `${item.entry.provider}-${item.entry.id}-${item.entry.name}` : item.emoji.c}
            item={item}
            selected={index === selected}
            onHover={() => onSelect(index)}
            onPick={() => onPick(item)}
          />
        ))}
      </div>
    </div>
  );
}
