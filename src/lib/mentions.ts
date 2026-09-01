import type { ChatMessage } from "../types";
import { messageText } from "./messageText";

/** How the message named you: with an `@` in front, or without. */
export type MentionKind = "tag" | "name";

/**
 * The compiled matchers for the signed-in login, kept between calls: every
 * incoming message is tested against them, and the login only changes on
 * sign-in or sign-out.
 */
let cached: { login: string; tag: RegExp; name: RegExp } | null = null;

function matchers(login: string) {
  if (cached?.login === login) return cached;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Whole word either way: "@you" and a bare "you" both count, "youtube" and
  // "areyou" don't. Twitch logins are [a-z0-9_], which is exactly the set \w
  // rules out on either side, so no separate boundary for the underscore.
  //
  // The bare matcher also rules out a leading @ -- otherwise every tag would
  // count as both kinds, and turning tag pings off wouldn't turn them off.
  cached = {
    login,
    tag: new RegExp(`(?:^|[^\\w])@${escaped}(?![\\w])`, "i"),
    name: new RegExp(`(?:^|[^\\w@])${escaped}(?![\\w])`, "i"),
  };
  return cached;
}

/**
 * How this message names the signed-in user, or null if it doesn't. A message
 * that does both is a tag: that's the louder of the two, and the notification
 * settings treat the kinds as separate switches.
 *
 * Your own messages never count: typing your own name shouldn't light up the
 * line you just sent, and neither should the ping that goes with it. Notices
 * are excluded too -- they're the server talking, with no author to match
 * against and nothing to reply to.
 */
export function mentionKind(message: ChatMessage, login: string | null): MentionKind | null {
  if (!login || message.kind === "notice") return null;
  if (message.login.toLowerCase() === login.toLowerCase()) return null;

  const text = messageText(message);
  const { tag, name } = matchers(login);
  if (tag.test(text)) return "tag";
  return name.test(text) ? "name" : null;
}

/** Whether the message names you at all. */
export function mentionsYou(message: ChatMessage, login: string | null): boolean {
  return mentionKind(message, login) !== null;
}

/** Whether the message is a reply to something you said. */
export function repliesToYou(message: ChatMessage, login: string | null): boolean {
  return Boolean(
    login && message.replyTo && message.replyTo.login.toLowerCase() === login.toLowerCase(),
  );
}

/**
 * Chat talking *to* you, either way round -- what the row highlight keys off,
 * and what the mentions tab collects. Being named and being replied to read
 * the same, so they share one answer rather than competing for the row.
 *
 * Never your own message, for the reason `mentionKind` gives: replying to
 * yourself isn't someone addressing you.
 */
export function isAboutYou(message: ChatMessage, login: string | null): boolean {
  if (!login || message.login.toLowerCase() === login.toLowerCase()) return false;
  return repliesToYou(message, login) || mentionsYou(message, login);
}
