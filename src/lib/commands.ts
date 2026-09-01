/**
 * The chat commands this client knows, for the `/` picker and the checks in
 * front of it.
 *
 * The catalog lives here rather than in Rust for the same reason mentions and
 * emote blacklists do: what it's used for depends on the granted scopes, which
 * change on sign-in with nothing rebuilt, and the picker has to answer on every
 * keystroke without a round trip. Rust owns the half that actually runs a
 * command -- see `twitch::commands` -- and Twitch has the final word either
 * way, so a command this list got wrong fails there with Twitch's own reason.
 */

import type { AuthStatus, ChannelRole } from "../types";

export type ChatCommand = {
  /** Lowercase, no slash -- what the backend matches on. */
  name: string;
  /** Other spellings Twitch accepts. Typing one runs (and completes to) it. */
  aliases?: string[];
  /** Arguments as the picker shows them; `<>` required, `[]` optional. */
  args?: string;
  summary: string;
  /** The Helix scope it needs, or null when plain chat access covers it. */
  scope: string | null;
  /** Refused anywhere but your own channel, by Twitch and by us. */
  broadcasterOnly?: boolean;
};

const MODERATE_USERS = "moderator:manage:banned_users";
const MODERATE_MESSAGES = "moderator:manage:chat_messages";
const CHAT_SETTINGS = "moderator:manage:chat_settings";

/**
 * Alphabetical, because that's the order the picker shows them in and there's
 * no ranking worth imposing on a list you're reading rather than recalling.
 */
export const COMMANDS: ChatCommand[] = [
  {
    name: "announce",
    aliases: ["announceblue", "announcegreen", "announceorange", "announcepurple"],
    args: "<message>",
    summary:
      "Post a highlighted announcement. /announceblue, /announcegreen, /announceorange and /announcepurple pick its color.",
    scope: "moderator:manage:announcements",
  },
  { name: "ban", args: "<user> [reason]", summary: "Ban someone from the channel.", scope: MODERATE_USERS },
  { name: "block", args: "<user>", summary: "Block someone across Twitch.", scope: "user:manage:blocked_users" },
  { name: "clear", summary: "Clear every message from chat.", scope: MODERATE_MESSAGES },
  {
    name: "color",
    args: "<color>",
    summary: "Set your name color -- a Twitch color name, or a hex code with Turbo or Prime.",
    scope: "user:manage:chat_color",
  },
  {
    name: "commercial",
    args: "[length]",
    summary: "Run an ad break: 30, 60, 90, 120, 150 or 180 seconds.",
    scope: "channel:edit:commercial",
    broadcasterOnly: true,
  },
  { name: "delete", args: "<message-id>", summary: "Delete one message.", scope: MODERATE_MESSAGES },
  { name: "emoteonly", summary: "Allow only emotes in chat.", scope: CHAT_SETTINGS },
  { name: "emoteonlyoff", summary: "Turn emote-only mode off.", scope: CHAT_SETTINGS },
  {
    name: "followers",
    args: "[duration]",
    summary: "Followers-only mode, optionally requiring a minimum follow age.",
    scope: CHAT_SETTINGS,
  },
  { name: "followersoff", summary: "Turn followers-only mode off.", scope: CHAT_SETTINGS },
  { name: "help", args: "[command]", summary: "List the commands, or explain one.", scope: null },
  {
    name: "marker",
    args: "[description]",
    summary: "Drop a marker in the stream's VOD.",
    scope: "channel:manage:broadcast",
  },
  { name: "me", args: "<message>", summary: "Send a message as an action, in your name color.", scope: null },
  {
    name: "mod",
    args: "<user>",
    summary: "Make someone a moderator.",
    scope: "channel:manage:moderators",
    broadcasterOnly: true,
  },
  {
    name: "mods",
    summary: "List your moderators.",
    scope: "channel:manage:moderators",
    broadcasterOnly: true,
  },
  {
    name: "raid",
    args: "<user>",
    summary: "Send your viewers to another channel.",
    scope: "channel:manage:raids",
    broadcasterOnly: true,
  },
  {
    name: "shoutout",
    args: "<user>",
    summary: "Give another channel a shoutout.",
    scope: "moderator:manage:shoutouts",
  },
  { name: "slow", args: "[seconds]", summary: "Slow mode, 30 seconds unless you say otherwise.", scope: CHAT_SETTINGS },
  { name: "slowoff", summary: "Turn slow mode off.", scope: CHAT_SETTINGS },
  { name: "subscribers", summary: "Subscribers-only chat.", scope: CHAT_SETTINGS },
  { name: "subscribersoff", summary: "Turn subscribers-only chat off.", scope: CHAT_SETTINGS },
  {
    name: "timeout",
    args: "<user> [duration] [reason]",
    summary: "Time someone out -- 10 minutes unless you give a duration like 30s or 1h.",
    scope: MODERATE_USERS,
  },
  {
    name: "unban",
    aliases: ["untimeout"],
    args: "<user>",
    summary: "Lift a ban or a timeout.",
    scope: MODERATE_USERS,
  },
  { name: "unblock", args: "<user>", summary: "Unblock someone.", scope: "user:manage:blocked_users" },
  {
    name: "unmod",
    args: "<user>",
    summary: "Remove someone's moderator status.",
    scope: "channel:manage:moderators",
    broadcasterOnly: true,
  },
  {
    name: "uniquechat",
    aliases: ["r9kbeta"],
    summary: "Unique-chat mode: no repeating what's already been said.",
    scope: CHAT_SETTINGS,
  },
  { name: "uniquechatoff", aliases: ["r9kbetaoff"], summary: "Turn unique-chat mode off.", scope: CHAT_SETTINGS },
  { name: "unraid", summary: "Cancel a raid before it goes.", scope: "channel:manage:raids", broadcasterOnly: true },
  {
    name: "unvip",
    args: "<user>",
    summary: "Remove someone's VIP status.",
    scope: "channel:manage:vips",
    broadcasterOnly: true,
  },
  {
    name: "vip",
    args: "<user>",
    summary: "Make someone a VIP.",
    scope: "channel:manage:vips",
    broadcasterOnly: true,
  },
  { name: "vips", summary: "List your VIPs.", scope: "channel:manage:vips", broadcasterOnly: true },
  {
    name: "w",
    aliases: ["whisper"],
    args: "<user> <message>",
    summary: "Whisper someone. Their replies arrive on Twitch, not here.",
    scope: "user:manage:whispers",
  },
  {
    name: "warn",
    args: "<user> <reason>",
    summary: "Warn someone, with a reason they have to acknowledge.",
    scope: "moderator:manage:warnings",
  },
];

/** How a command reads in the picker and in `/help`. */
export function usage(command: ChatCommand, name = command.name): string {
  return command.args ? `/${name} ${command.args}` : `/${name}`;
}

/**
 * The command word and its arguments, or null for anything that isn't one.
 * Mirrors `twitch::commands::split_command`, including treating a bare "/" and
 * a leading "//" as ordinary text.
 */
export function splitCommand(input: string): { name: string; args: string } | null {
  const rest = input.trimStart();
  if (!rest.startsWith("/")) return null;
  const body = rest.slice(1);
  const end = body.search(/\s/);
  const name = end === -1 ? body : body.slice(0, end);
  if (!name || !/^[a-z0-9]+$/i.test(name)) return null;
  return { name: name.toLowerCase(), args: (end === -1 ? "" : body.slice(end)).trim() };
}

/** The command a name or alias refers to. */
export function findCommand(name: string): ChatCommand | null {
  const needle = name.toLowerCase();
  return (
    COMMANDS.find((command) => command.name === needle || command.aliases?.includes(needle)) ?? null
  );
}

/**
 * One picker row: a command plus the name that matched, so an alias completes
 * to itself. Typing "/announceb" should give you `/announceblue`, not the
 * `/announce` its entry is filed under.
 */
export type CommandMatch = { command: ChatCommand; name: string };

/**
 * Whether a command is any use in a channel you hold `role` in.
 *
 * Every moderator scope is named for the job, so needing one means needing to
 * be a moderator here -- and the broadcaster counts as one. This is about the
 * channel rather than the account: a granted scope doesn't make you a mod in
 * someone else's chat, and Twitch checks that separately.
 */
export function availableHere(command: ChatCommand, role: ChannelRole): boolean {
  if (command.broadcasterOnly) return role === "broadcaster";
  if (command.scope?.startsWith("moderator:")) return role !== "viewer";
  return true;
}

/**
 * Commands whose name or alias starts with `query`, alphabetically, and that
 * you could actually run where you're typing. An empty query lists them all --
 * typing "/" alone is how you go looking.
 *
 * Commands your role rules out are left out rather than marked: nothing you can
 * do in this channel makes `/ban` work if you aren't a moderator in it, so the
 * row would be a dead end. Ones you're only missing a *permission* for do still
 * appear, marked -- that one you can act on.
 *
 * An alias only appears when it's what you're typing, so the list stays one row
 * per command until you reach for a specific spelling of one.
 */
export function matchCommands(query: string, role: ChannelRole): CommandMatch[] {
  const needle = query.toLowerCase();
  const matches: CommandMatch[] = [];
  for (const command of COMMANDS) {
    if (!availableHere(command, role)) continue;
    const alias = needle ? command.aliases?.find((name) => name.startsWith(needle)) : undefined;
    if (alias) matches.push({ command, name: alias });
    else if (command.name.startsWith(needle)) matches.push({ command, name: command.name });
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The command word being typed at the caret, or null.
 *
 * Only ever the first word of the line -- a slash anywhere else is a url, a
 * date or a fraction -- and only while the caret is still inside it, so the
 * picker gets out of the way once you start on the arguments.
 */
export function commandQuery(value: string, caret: number): { query: string } | null {
  if (!value.startsWith("/")) return null;
  const end = value.search(/\s/);
  const word = end === -1 ? value : value.slice(0, end);
  if (caret > word.length) return null;
  const query = word.slice(1);
  return /^[a-z0-9]*$/i.test(query) ? { query } : null;
}

/** The permission group a scope belongs to, for naming it in a message. */
function groupFor(scope: string, auth: AuthStatus) {
  return auth.permissionCatalog.find((group) => group.scopes.includes(scope)) ?? null;
}

/**
 * Why a command can't run right now, or null if it can.
 *
 * The granted scopes are checked before the sign-in state on purpose: they're
 * the actual answer, and checking them first is what lets mock mode exercise
 * the picker's unlocked rows without pretending to be signed in.
 */
export function commandProblem(command: ChatCommand, auth: AuthStatus): string | null {
  if (!command.scope) return null;
  if (auth.scopes.includes(command.scope)) return null;
  if (!auth.loggedIn) return `Sign in to use /${command.name}.`;

  const group = groupFor(command.scope, auth);
  const label = group ? `"${group.label}"` : command.scope;
  return `/${command.name} needs the ${label} permission. Turn it on in Settings, under Account, then sign in again.`;
}

/** The short marker a locked row shows, rather than its whole explanation. */
export function problemLabel(command: ChatCommand, auth: AuthStatus): string | null {
  if (!command.scope || auth.scopes.includes(command.scope)) return null;
  return auth.loggedIn ? "needs permission" : "sign in";
}

/**
 * What `/help` prints, one notice per line.
 *
 * With a command named it's that command's arguments; otherwise it's every
 * command grouped by the permission that unlocks it, which is also the answer
 * to "why can't I run this" for a group that hasn't been granted.
 */
export function helpLines(query: string, auth: AuthStatus): string[] {
  const asked = query.trim().replace(/^\//, "");
  if (asked) {
    const command = findCommand(asked);
    if (!command) return [`No such command: /${asked}`];

    const lines = [`${usage(command)} -- ${command.summary}`];
    if (command.aliases?.length) {
      lines.push(`Also: ${command.aliases.map((name) => `/${name}`).join(", ")}`);
    }
    if (command.broadcasterOnly) lines.push("Only works in your own channel.");
    const problem = commandProblem(command, auth);
    if (problem) lines.push(problem);
    return lines;
  }

  const names = (commands: ChatCommand[]) =>
    commands.map((command) => `/${command.name}`).join(", ");

  const lines = [`Always available: ${names(COMMANDS.filter((command) => !command.scope))}`];
  for (const group of auth.permissionCatalog) {
    const covered = COMMANDS.filter(
      (command) => command.scope && group.scopes.includes(command.scope),
    );
    if (covered.length === 0) continue;
    // "Granted" is per group rather than per scope: Twitch hands them out
    // together, so one being present means the group was approved.
    const granted = group.scopes.some((scope) => auth.scopes.includes(scope));
    const suffix = granted ? "" : " -- not granted yet, see Settings, under Account";
    lines.push(`${group.label}${suffix}: ${names(covered)}`);
  }
  lines.push("Type /help <command> for one command's arguments.");
  return lines;
}
