/** Twitch accepts timeouts from one second through two weeks. */
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 1_209_600;
export const DEFAULT_TIMEOUT_SECONDS = 600;

export const TIMEOUT_PRESETS = [
  60,
  300,
  600,
  1_800,
  3_600,
  28_800,
  86_400,
  604_800,
  MAX_TIMEOUT_SECONDS,
] as const;

export const TIMEOUT_UNITS = [
  { id: "seconds", label: "seconds", seconds: 1 },
  { id: "minutes", label: "minutes", seconds: 60 },
  { id: "hours", label: "hours", seconds: 3_600 },
  { id: "days", label: "days", seconds: 86_400 },
  { id: "weeks", label: "weeks", seconds: 604_800 },
] as const;

export type TimeoutUnit = (typeof TIMEOUT_UNITS)[number]["id"];

const plural = (amount: number, unit: string) => `${amount} ${unit}${amount === 1 ? "" : "s"}`;

/** A compact human label for settings and context-menu actions. */
export function formatTimeout(seconds: number): string {
  const units = [
    [604_800, "week"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ] as const;
  const [size, label] = units.find(([size]) => seconds % size === 0) ?? units[4];
  return plural(seconds / size, label);
}

/** Start an arbitrary-duration editor with the least surprising whole unit. */
export function timeoutParts(seconds: number): { amount: number; unit: TimeoutUnit } {
  for (const unit of [...TIMEOUT_UNITS].reverse()) {
    if (seconds % unit.seconds === 0) return { amount: seconds / unit.seconds, unit: unit.id };
  }
  return { amount: seconds, unit: "seconds" };
}

export function timeoutSeconds(amount: number, unit: TimeoutUnit): number {
  return amount * (TIMEOUT_UNITS.find((candidate) => candidate.id === unit)?.seconds ?? 1);
}

export function validTimeout(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_TIMEOUT_SECONDS &&
    seconds <= MAX_TIMEOUT_SECONDS
  );
}
