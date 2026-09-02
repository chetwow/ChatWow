import type { ChatMessage, Segment } from "../types";

function segmentText(segment: Segment): string {
  switch (segment.kind) {
    case "text":
      return segment.text;
    case "emote":
      return segment.name;
    case "mention":
      return segment.text;
    case "link":
      return segment.text;
  }
}

/** Reconstructs a message's plain-text body, e.g. for copying or quoting in a reply. */
export function messageText(message: ChatMessage): string {
  return message.segments.map(segmentText).join("");
}

/** The clock time drawn beside a row -- and copied with it. Empty for a
 * message with no timestamp, which is what a locally-printed line has. */
export function messageTime(ts: number): string {
  if (!ts) return "";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * A message as a line you could paste somewhere else: who said it and what
 * they said, led by the time when the reader has timestamps on -- so what
 * lands on the clipboard is what was on the screen.
 *
 * A row with no body of its own (a notice, a sub event nobody wrote a message
 * on) is its system line, and carries no name: nobody said it.
 */
export function messageLine(message: ChatMessage, withTime: boolean): string {
  const time = withTime ? messageTime(message.ts) : "";
  const body = messageText(message);
  // `/me` reads as the sender doing something, so no colon -- the same shape
  // Twitch and every other client print it in.
  const said = !body
    ? (message.systemMessage ?? "")
    : message.isAction
      ? `${message.displayName} ${body}`
      : `${message.displayName}: ${body}`;
  return time ? `${time} ${said}` : said;
}
