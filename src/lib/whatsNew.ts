import changelog from "../../CHANGELOG.md?raw";
import packageInfo from "../../package.json";
import { api } from "./api";
import { MOCK_MODE } from "./tauri";
import { parseReleaseNotes, type ReleaseNotes } from "./releaseNotes";

export const CURRENT_VERSION = packageInfo.version;
export const CURRENT_RELEASE_NOTES = parseReleaseNotes(changelog, CURRENT_VERSION);

const MOCK_SEEN_KEY = "chatwow.whatsNewVersion";

/** The current release only, when this build has not been acknowledged yet. */
export async function unseenReleaseNotes(): Promise<ReleaseNotes | null> {
  if (!CURRENT_RELEASE_NOTES) return null;
  const seen = MOCK_MODE ? localStorage.getItem(MOCK_SEEN_KEY) : await api.lastSeenVersion();
  return seen === CURRENT_VERSION ? null : CURRENT_RELEASE_NOTES;
}

/** Called only when the popup is dismissed, so a crash cannot eat the notes. */
export async function acknowledgeReleaseNotes(): Promise<void> {
  if (MOCK_MODE) {
    localStorage.setItem(MOCK_SEEN_KEY, CURRENT_VERSION);
    return;
  }
  await api.acknowledgeWhatsNew();
}
