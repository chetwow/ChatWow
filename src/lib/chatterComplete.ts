/**
 * `@` completion for the composer.
 *
 * Unlike emotes there's no inventory to fetch: the candidates are simply the
 * people who have talked in this channel since the app started, collected off
 * incoming messages. Nothing is ranked -- there are no use counts to rank by,
 * and alphabetical is what makes a Tab cycle predictable.
 */

/** Chatters seen in a channel: lowercase login -> the name as they display it. */
export type Chatters = Record<string, string>;

/**
 * Display names starting with `prefix`, alphabetically. Both the login and the
 * display name are matched -- they differ for anyone with a localized name --
 * but what's inserted is always the display name, which is what reads back as
 * the person you meant.
 *
 * An empty prefix matches everyone, so a bare `@` plus Tab walks the channel.
 */
export function matchChatters(chatters: Chatters | undefined, prefix: string): string[] {
  if (!chatters) return [];
  const needle = prefix.toLowerCase();
  const matches = Object.entries(chatters)
    .filter(([login, name]) => login.startsWith(needle) || name.toLowerCase().startsWith(needle))
    .map(([, name]) => name);
  return matches.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
