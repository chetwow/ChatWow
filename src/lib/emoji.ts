/**
 * Emoji for the emote picker.
 *
 * The data is generated from Python's Unicode tables (see
 * `scripts/generate-emoji.py`) rather than pulled from a package, and is
 * dynamically imported so its ~68KB never lands in the initial bundle -- the
 * picker only needs it once someone starts typing a search.
 */

export type Emoji = {
  /** The character itself, which is what gets inserted: Twitch doesn't expand `:shortcode:`. */
  c: string;
  /** Official Unicode name, lowercased, e.g. "face with tears of joy". */
  n: string;
};

let loaded: Emoji[] | null = null;
let loading: Promise<Emoji[]> | null = null;

/** Load (once) and cache the emoji list. */
export function loadEmoji(): Promise<Emoji[]> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("./emoji.json").then((module) => {
    loaded = module.default as Emoji[];
    return loaded;
  });
  return loading;
}

/**
 * Emoji matching `query`, best first: a name that starts with it, then a name
 * with a *word* starting with it (so "joy" finds "face with tears of joy"),
 * then anything containing it. Alphabetical within each tier, which is the
 * order the data is already in.
 */
export function searchEmoji(emoji: Emoji[], query: string): Emoji[] {
  const needle = query.toLowerCase();
  if (!needle) return [];

  const exact: Emoji[] = [];
  const word: Emoji[] = [];
  const anywhere: Emoji[] = [];

  for (const found of emoji) {
    if (found.n.startsWith(needle)) exact.push(found);
    else if (found.n.includes(` ${needle}`)) word.push(found);
    else if (found.n.includes(needle)) anywhere.push(found);
  }

  return [...exact, ...word, ...anywhere];
}
