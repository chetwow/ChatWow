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
