/**
 * Username completion for the composer and listener editor.
 *
 * Unlike emotes there's no inventory to fetch: the candidates are simply the
 * people who have talked in this channel since the app started, collected off
 * incoming messages. Nothing is ranked -- there are no use counts to rank by,
 * and alphabetical is what makes a Tab cycle predictable.
 */

import { wordBeforeCaret } from "./emoteComplete";

/** Chatters seen in a channel: lowercase login -> the name as they display it. */
export type Chatters = Record<string, string>;

/** One visible suggestion, retaining the login used by listener filters. */
export type ChatterMatch = { login: string; name: string };

/** The `@query` token being typed at the caret, if there is one. */
export function chatterQuery(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const { start, word } = wordBeforeCaret(value, caret);
  if (!word.startsWith("@")) return null;
  const query = word.slice(1);
  return /^[a-z0-9_]*$/i.test(query) ? { start, query } : null;
}

/** Merge per-tab chatter maps without losing their display-name casing. */
export function mergeChatters(groups: Array<Chatters | undefined>): Chatters {
  const merged: Chatters = {};
  for (const group of groups) {
    if (!group) continue;
    for (const [login, name] of Object.entries(group)) merged[login] ??= name;
  }
  return merged;
}

/** Structured prefix matches for visible pickers. */
export function findChatters(chatters: Chatters | undefined, prefix: string): ChatterMatch[] {
  if (!chatters) return [];
  const needle = prefix.toLowerCase();
  return Object.entries(chatters)
    .filter(([login, name]) => login.startsWith(needle) || name.toLowerCase().startsWith(needle))
    .map(([login, name]) => ({ login, name }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/**
 * Display names starting with `prefix`, alphabetically. Both the login and the
 * display name are matched -- they differ for anyone with a localized name --
 * but what's inserted is always the display name, which is what reads back as
 * the person you meant.
 *
 * An empty prefix matches everyone, so a bare `@` opens the composer picker
 * and Tab can walk the same channel inventory.
 */
export function matchChatters(chatters: Chatters | undefined, prefix: string): string[] {
  return findChatters(chatters, prefix).map(({ name }) => name);
}
