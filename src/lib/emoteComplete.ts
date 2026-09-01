/**
 * Emote completion and search for the composer.
 *
 * The candidate list arrives from the backend already sorted case-insensitively
 * (see `AppState::emote_entries`), so ranking here only has to float the emotes
 * you use most to the top and let that alphabetical order stand as the tiebreak.
 */

import type { Emoji } from "./emoji";
import type { EmoteEntry } from "../types";

/** A run of Tab presses over one half-typed word. */
export type Completion = {
  /** Text before the word being completed, fixed for the whole run. */
  head: string;
  /** Text after it, likewise fixed -- so cycling can't drift into the rest of the line. */
  tail: string;
  matches: string[];
  index: number;
  /** What follows the inserted text -- a space for emotes, ", " for an @. */
  suffix: string;
  /** What we last wrote into the input, to tell our own edit from the user typing. */
  value: string;
  caret: number;
};

/** The word the caret sits at the end of, and where in `value` it starts. */
export function wordBeforeCaret(value: string, caret: number): { start: number; word: string } {
  const before = value.slice(0, caret);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
  return { start, word: value.slice(start, caret) };
}

/**
 * Most-used first. Array.prototype.sort is stable, so emotes used equally often
 * keep the alphabetical order the backend sent them in.
 */
function byUse(entries: EmoteEntry[], uses: Record<string, number>): EmoteEntry[] {
  return [...entries].sort((a, b) => (uses[b.name] ?? 0) - (uses[a.name] ?? 0));
}

/**
 * Emotes starting with `prefix`, most-used first. Matching ignores case --
 * typing "pep" should find "PepeLaugh" -- but the completion inserts the
 * emote's real name, which is what Twitch and 7TV actually match on.
 */
export function rankMatches(
  entries: EmoteEntry[],
  prefix: string,
  uses: Record<string, number>,
): EmoteEntry[] {
  const needle = prefix.toLowerCase();
  if (!needle) return [];
  return byUse(
    entries.filter((entry) => entry.name.toLowerCase().startsWith(needle)),
    uses,
  );
}

/**
 * Splice a completion into the line, followed by `suffix` so you can keep
 * typing. A space already sitting there is reused rather than doubled: the
 * suffix loses its own trailing space and the caret steps over the existing
 * one instead, which is what keeps "@name, " from becoming "@name,  ".
 */
export function applyCompletion(
  head: string,
  tail: string,
  text: string,
  suffix = " ",
): { value: string; caret: number } {
  const reusesSpace = tail.startsWith(" ");
  const inserted = reusesSpace ? suffix.trimEnd() : suffix;
  return {
    value: head + text + inserted + tail,
    caret: head.length + text.length + inserted.length + (reusesSpace ? 1 : 0),
  };
}

/** A row in the emote picker: a channel emote, or an emoji. */
export type PickerItem =
  | { kind: "emote"; entry: EmoteEntry }
  | { kind: "emoji"; emoji: Emoji };

/** How many of each kind the picker will show at once. */
const EMOTE_LIMIT = 50;
const EMOJI_LIMIT = 20;

/**
 * The `:` token being typed at the caret, or null if there isn't one. The
 * trigger has to start a word, so a timestamp ("19:00") or a url ("http://x")
 * never opens the picker.
 */
export function pickerQuery(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const { start, word } = wordBeforeCaret(value, caret);
  if (!word.startsWith(":")) return null;
  const query = word.slice(1);
  // A second colon means it's no longer a search -- ":)" and the like.
  return query.includes(":") ? null : { start, query };
}

/**
 * What the picker shows for a query.
 *
 * With nothing typed it's your most-used emotes. Once there are letters,
 * emotes whose name *starts* with them come first and emotes that merely
 * contain them follow, so an exact prefix is never buried under a coincidental
 * substring hit but a mid-name match is still reachable. Emojis come after
 * every emote, including emojis that do start with the query -- the channel's
 * own emotes are what you're usually reaching for.
 */
export function searchPicker(
  entries: EmoteEntry[],
  query: string,
  uses: Record<string, number>,
  emoji: Emoji[],
): PickerItem[] {
  if (!query) {
    return byUse(entries, uses)
      .slice(0, EMOTE_LIMIT)
      .map((entry) => ({ kind: "emote", entry }));
  }

  const needle = query.toLowerCase();
  const prefixed = rankMatches(entries, query, uses);
  const contained = byUse(
    entries.filter((entry) => {
      const name = entry.name.toLowerCase();
      return !name.startsWith(needle) && name.includes(needle);
    }),
    uses,
  );

  return [
    ...[...prefixed, ...contained]
      .slice(0, EMOTE_LIMIT)
      .map((entry): PickerItem => ({ kind: "emote", entry })),
    ...emoji.slice(0, EMOJI_LIMIT).map((found): PickerItem => ({ kind: "emoji", emoji: found })),
  ];
}

/** The text a picked row puts into the message. */
export function itemText(item: PickerItem): string {
  return item.kind === "emote" ? item.entry.name : item.emoji.c;
}

/** The emote names actually present in a message, for the usage ranking. */
export function emotesIn(text: string, names: Set<string>): string[] {
  return text.split(/\s+/).filter((word) => names.has(word));
}
