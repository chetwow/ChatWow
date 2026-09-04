/**
 * Loading and phrasing the card behind a clicked username.
 *
 * Rust does the fetching (see `usercard.rs` for why it takes two services);
 * this is the session cache in front of it and the date arithmetic behind the
 * two "N years ago" lines. Both live here rather than in the store: nothing
 * outside the card reads them, and unlike the 7TV badges these never have to
 * repaint a message that's already on screen.
 */

import { api } from "./api";
import { MOCK_MODE } from "./tauri";
import type { UserCard } from "../types";

/**
 * Cached for the session, keyed by channel as well as name -- the follow and
 * subscription half is about this pair, not about the person. Nothing here
 * changes minute to minute, and reopening a card should be instant.
 */
const cache = new Map<string, UserCard>();
/** In-flight requests, so double-clicking a name asks once. */
const pending = new Map<string, Promise<UserCard>>();

const keyFor = (login: string, channel: string) => `${channel}|${login.toLowerCase()}`;

/** What we already hold, for painting the card before the request resolves. */
export function cachedUserCard(login: string, channel: string): UserCard | undefined {
  return cache.get(keyFor(login, channel));
}

export function loadUserCard(login: string, channel: string): Promise<UserCard> {
  const key = keyFor(login, channel);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const request = (
    MOCK_MODE
      ? import("../dev/mockData").then((mock) => mock.mockUserCard(login))
      : api.userCard(login, channel)
  )
    .then((card) => {
      cache.set(key, card);
      return card;
    })
    .finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}

/** "May 19, 2011" -- in whatever order the user's locale writes it. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Whole calendar months between two dates, not an average-length estimate. */
function monthsBetween(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return months;
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * How long ago, to one unit: "14 years", "7 months", "12 days". The exact date
 * is shown beside it, so the remainder would only be a longer way of saying
 * what's already there -- and the card's rows are one line each.
 *
 * An account made this week doesn't round up to a month, which is the only
 * case where the difference is worth the extra unit.
 */
export function describeSince(iso: string, now: number = Date.now()): string {
  const from = new Date(iso);
  if (Number.isNaN(from.getTime())) return "";
  const to = new Date(now);

  const months = monthsBetween(from, to);
  if (months < 1) {
    const days = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
    return days === 0 ? "today" : plural(days, "day");
  }
  if (months < 12) return plural(months, "month");
  return plural(Math.floor(months / 12), "year");
}
