/** Shared with Settings' info-dot explanations. */
export const TEXT_TOOLTIP_STYLE = "rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-lg shadow-black/50";

export function textTooltipPosition(
  anchor: { left: number; right: number; top: number; bottom: number },
  width: number, height: number, viewportWidth: number, viewportHeight: number,
) {
  const gap = 5;
  const edge = 8;
  return {
    left: Math.max(edge, Math.min((anchor.left + anchor.right - width) / 2, viewportWidth - width - edge)),
    top: Math.max(edge, Math.min(
      anchor.bottom + gap + height <= viewportHeight - edge ? anchor.bottom + gap : anchor.top - height - gap,
      viewportHeight - height - edge,
    )),
  };
}
