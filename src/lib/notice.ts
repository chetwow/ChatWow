import type { ChatMessage } from "../types";

/**
 * A locally generated status line, shaped exactly like the ones Rust sends
 * (`render::notice`) so it renders through the same path: no timestamp, no
 * name, italic and dimmed. Used for what a slash command reports back and for
 * `/help`, neither of which comes from Twitch.
 */
export function localNotice(channel: string, text: string): ChatMessage {
  return {
    id: "",
    channel,
    ts: 0,
    login: "",
    displayName: "",
    color: "#8b8b93",
    badges: [],
    segments: [],
    isAction: false,
    isFirstMessage: false,
    kind: "notice",
    historical: false,
    systemMessage: text,
    replyTo: null,
  };
}
