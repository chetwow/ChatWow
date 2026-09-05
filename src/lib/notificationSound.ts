import type { Preferences } from "../types";

type SoundPreferences = Pick<
  Preferences,
  "muted" | "muteActiveTab" | "muteWhenWindowActive"
>;

/** Whether one otherwise-qualifying event is allowed to play the ping. */
export function notificationSoundAllowed(
  preferences: SoundPreferences,
  windowActive: boolean,
  watching: boolean,
  whisper = false,
): boolean {
  if (preferences.muted) return false;
  if (preferences.muteWhenWindowActive && windowActive) return false;
  // Preserve the existing exception: a whisper arrived from outside the room,
  // so merely looking at the tab where it was filed doesn't imply it was seen.
  if (whisper) return true;
  return !watching || !preferences.muteActiveTab;
}

/** Focus is the user-facing meaning of the app window being active. */
export function windowIsActive(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}
