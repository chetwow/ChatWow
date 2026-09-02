import type { AuthStatus, NewTabAvatarMode, Tab, TabAvatarMode } from "../types";

/** The three a tab can be on, in the order its right-click menu lists them. */
export const TAB_AVATAR_MODES: { id: TabAvatarMode; label: string }[] = [
  { id: "none", label: "None" },
  { id: "owner", label: "Channel Owner" },
  { id: "account", label: "User Account" },
];

/**
 * Those three plus the rule, for the setting that stamps a new tab. The rule
 * is only ever a *default*: a tab holds what it was stamped with, so nothing
 * has to work out later what "unless it's your default" means for a tab whose
 * account has changed since.
 */
export const NEW_TAB_AVATAR_MODES: { id: NewTabAvatarMode; label: string }[] = [
  ...TAB_AVATAR_MODES,
  { id: "otherAccount", label: "User Account (unless default)" },
];

/**
 * Which picture, if any, sits behind one tab's name.
 *
 * Resolved in the frontend rather than stamped into the tab in Rust for the
 * same reason mentions are: the picture behind `account` follows whichever
 * account the tab is on and whatever Twitch last said that account looks like,
 * neither of which rebuilds a tab.
 *
 * An empty string means draw nothing, which is also what every unanswerable
 * case comes to: a channel nobody has fetched an owner for (signed out, or
 * joined a moment ago), an account with no picture or none at all, and a
 * mentions tab under `owner`, since it belongs to an account, not to a room.
 */
export function tabAvatar(
  tab: Tab,
  auth: AuthStatus,
  channelAvatars: Record<string, string>,
): string {
  switch (tab.avatarMode) {
    case "none":
      return "";
    case "owner":
      return channelAvatars[tab.channel] ?? "";
    default:
      return auth.accounts.find((held) => held.id === tab.account)?.avatarUrl ?? "";
  }
}
