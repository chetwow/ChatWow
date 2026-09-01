/**
 * Emote blacklists: which emotes render as text instead of an image, and which
 * stay out of completion.
 *
 * Matching lives in the frontend rather than `render.rs` for the same reason
 * `mentions.ts` does -- it depends on state that changes without the resolved
 * backlog being rebuilt. Blacklisting an emote from the chat context menu has
 * to repaint the messages already on screen, and those are immutable once the
 * store has them.
 *
 * A rule matches on one of two things:
 *   - `name` -- the emote's name *in this channel*, compared exactly, since
 *     that's how emote names are matched everywhere else in the app. Catches
 *     every emote going by that name, which is the point for an alias spammed
 *     as a single letter.
 *   - `id` -- the `<provider>-<id>` image key, the same one the on-disk cache
 *     uses. Catches one specific image however it's been aliased.
 */

import type { EmoteRule } from "../types";

/** Anything with the fields a rule matches against: emote segments, overlays, completion entries. */
export type EmoteLike = {
  id: string;
  name: string;
  provider: string;
};

/** The `<provider>-<id>` key an `id` rule carries. Mirrors the image cache's key. */
export function imageKey(emote: EmoteLike): string {
  return `${emote.provider}-${emote.id}`;
}

/** A rule's identity, for deduping and for keying React lists. */
export function ruleKey(rule: EmoteRule): string {
  return `${rule.kind}:${rule.value}`;
}

type Lookup = { names: Set<string>; ids: Set<string> };

/**
 * Rules are consulted once per emote segment per render, so the Sets are built
 * once per list rather than once per lookup. The cache is keyed on the array's
 * identity: `updatePreferences` always replaces the array, and the store hands
 * out the same reference until it does, so a stale entry isn't reachable.
 */
const cache = new WeakMap<readonly EmoteRule[], Lookup>();

function lookup(rules: readonly EmoteRule[]): Lookup {
  const hit = cache.get(rules);
  if (hit) return hit;
  const built: Lookup = { names: new Set(), ids: new Set() };
  for (const rule of rules) {
    (rule.kind === "id" ? built.ids : built.names).add(rule.value);
  }
  cache.set(rules, built);
  return built;
}

/** Whether any rule in the list covers this emote. */
export function isBlacklisted(emote: EmoteLike, rules: readonly EmoteRule[]): boolean {
  if (rules.length === 0) return false;
  const { names, ids } = lookup(rules);
  return names.has(emote.name) || ids.has(imageKey(emote));
}

/**
 * The rules covering this emote, so the context menu can name what it's about
 * to remove -- an emote hidden by id under an alias you don't recognize is
 * otherwise unexplainable from chat alone.
 */
export function rulesMatching(emote: EmoteLike, rules: readonly EmoteRule[]): EmoteRule[] {
  const key = imageKey(emote);
  return rules.filter((rule) => (rule.kind === "id" ? rule.value === key : rule.value === emote.name));
}

/** The list with `rule` added, or unchanged if an identical rule is already in it. */
export function withRule(rules: readonly EmoteRule[], rule: EmoteRule): EmoteRule[] {
  const key = ruleKey(rule);
  return rules.some((existing) => ruleKey(existing) === key) ? [...rules] : [...rules, rule];
}

/** The list without `rule`. */
export function withoutRule(rules: readonly EmoteRule[], rule: EmoteRule): EmoteRule[] {
  const key = ruleKey(rule);
  return rules.filter((existing) => ruleKey(existing) !== key);
}

/** Drop the entries a blacklist covers. Used for both Tab and the `:` picker. */
export function filterBlacklisted<T extends EmoteLike>(
  entries: readonly T[],
  rules: readonly EmoteRule[],
): T[] {
  if (rules.length === 0) return entries as T[];
  return entries.filter((entry) => !isBlacklisted(entry, rules));
}

/**
 * Coerce whatever came out of `settings.json` into usable rules. The file is
 * hand-editable and Rust deliberately doesn't validate it, so anything with a
 * bad shape, an unknown kind or an empty value is dropped here rather than
 * silently matching nothing (or everything) later. Duplicates collapse.
 */
export function normalizeRules(raw: unknown): EmoteRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: EmoteRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, value } = entry as Partial<EmoteRule>;
    if ((kind !== "name" && kind !== "id") || typeof value !== "string" || !value) continue;
    const rule: EmoteRule = { kind, value };
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}
