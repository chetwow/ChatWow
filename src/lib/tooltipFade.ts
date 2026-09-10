export const TOOLTIP_FADE_MS = 400;
export const TOOLTIP_FADE_STYLE = "transition-[opacity,visibility] duration-400 ease-in-out motion-reduce:transition-none";

/** Cancel both entry frames and delayed removal when another hint replaces this one. */
export function scheduleTooltipFade(
  show: boolean,
  setVisible: (visible: boolean) => void,
  remove: () => void,
  reducedMotion: boolean,
) {
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (show) {
    if (reducedMotion) setVisible(true);
    // Let the positioned, transparent popup paint before starting its transition.
    else frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setVisible(true));
    });
  } else {
    setVisible(false);
    if (reducedMotion) remove();
    else timer = setTimeout(remove, TOOLTIP_FADE_MS);
  }
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
