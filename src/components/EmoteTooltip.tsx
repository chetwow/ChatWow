import { useTooltip } from "../store/tooltip";

const LABEL: Record<string, string> = {
  twitch: "Twitch",
  "7tv": "7TV",
};

export function EmoteTooltip() {
  const { emote, x, y } = useTooltip();
  if (!emote) return null;

  return (
    <div
      className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-full pb-2"
      style={{ left: x, top: y }}
    >
      <div className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface-raised p-2 shadow-xl shadow-black/50">
        <img src={emote.urlLarge} alt={emote.name} className="h-16 max-w-none object-contain" />
        <div className="text-[11px] font-semibold text-ink">{emote.name}</div>
        <div className="text-[10px] text-ink-faint">{LABEL[emote.provider] ?? emote.provider}</div>
      </div>
    </div>
  );
}
