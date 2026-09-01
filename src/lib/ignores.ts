/**
 * Two lists of people (and places) to hear less from.
 *
 * *Mention ignores* are one mixed list: `@login` says don't tell me when that
 * person names me, `#channel` says don't tell me about mentions in that room.
 * They're the same instruction with different scope, so they share a list --
 * the prefix is what it applies to, and it's what you type to add one.
 *
 * *Blocked users* are stronger and simpler: their messages aren't drawn at all,
 * anywhere. Only logins, since blocking a channel is just leaving it.
 *
 * Both are matched here in the frontend rather than in `render.rs`, for the
 * reason the emote blacklists are: the messages already on screen were resolved
 * before you added the rule and are immutable, so filtering in Rust would only
 * reach messages that arrive afterwards.
 */

import type { ChatMessage } from "../types";

/** Twitch logins and channel names are the same shape. */
const NAME = /^[a-z0-9_]{1,25}$/;

/**
 * Whatever was typed, as a list entry -- or null if there's no name in it.
 *
 * A bare word is taken as a person: `@` is the common case by a distance, and
 * a channel is the one you have to be explicit about (you're already looking
 * at its `#` in the tab bar).
 */
export function normalizeIgnore(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const prefix = trimmed[0] === "#" ? "#" : "@";
  const name = trimmed.replace(/^[@#]/, "");
  return NAME.test(name) ? `${prefix}${name}` : null;
}

/** A login as a list entry, for the chat context menu. */
export const ignoreForUser = (login: string) => `@${login.toLowerCase()}`;
/** A channel as a list entry. */
export const ignoreForChannel = (channel: string) => `#${channel.toLowerCase()}`;

/** Whether this message's mention of you is one you've asked not to hear about. */
export function mentionIgnored(message: ChatMessage, ignores: string[]): boolean {
  if (ignores.length === 0) return false;
  return (
    ignores.includes(ignoreForUser(message.login)) ||
    // A whisper's channel is only wherever you were reading when it arrived,
    // so a channel rule has no business silencing one.
    (message.kind !== "whisper" && ignores.includes(ignoreForChannel(message.channel)))
  );
}

/** Whether this message should be drawn at all. */
export function userBlocked(message: ChatMessage, blocked: string[]): boolean {
  if (blocked.length === 0 || !message.login) return false;
  return blocked.includes(message.login.toLowerCase());
}

/** Add an entry, keeping the list sorted and free of duplicates. */
export function withEntry(list: string[], entry: string): string[] {
  return list.includes(entry) ? list : [...list, entry].sort();
}

export function withoutEntry(list: string[], entry: string): string[] {
  return list.filter((existing) => existing !== entry);
}

/**
 * Coerce a hand-edited `settings.json` into something usable: entries that
 * aren't a name are dropped rather than sitting in the list matching nothing,
 * and the result is deduplicated and sorted the way the editor writes it.
 */
export function normalizeIgnores(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map(normalizeIgnore)
    .filter((entry): entry is string => entry !== null);
  return [...new Set(entries)].sort();
}

/** The same, for the blocked list, which holds bare logins. */
export function normalizeLogins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const logins = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase().replace(/^[@#]/, ""))
    .filter((entry) => NAME.test(entry));
  return [...new Set(logins)].sort();
}
