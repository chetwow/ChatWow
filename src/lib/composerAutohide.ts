/** Explicit tab choices take precedence over the shared unfocused-input rule. */
export function composerAutohideEnabled(override: boolean | null | undefined, unfocusedDefault: boolean) {
  return override ?? unfocusedDefault;
}

export function normalizeComposerAutohideDelay(seconds: number) {
  return Number.isFinite(seconds) ? Math.min(30, Math.max(0, seconds)) : 2;
}

/** Each focus/hover/menu change cancels the old countdown before starting a new one. */
export function scheduleComposerAutohide(state: {
  enabled: boolean;
  inputFocused: boolean;
  hovered: boolean;
  menuOpen: boolean;
  delaySeconds: number;
}, hide: () => void) {
  if (!state.enabled || state.inputFocused || state.hovered || state.menuOpen) return;
  const timer = setTimeout(hide, normalizeComposerAutohideDelay(state.delaySeconds) * 1000);
  return () => clearTimeout(timer);
}
