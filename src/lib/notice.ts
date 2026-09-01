import type { ChatMessage, Tab } from "../types";

/**
 * A locally generated status line, shaped exactly like the ones Rust sends
 * (`render::notice`) so it renders through the same path: no timestamp, no
 * name, italic and dimmed. Used for what a slash command reports back and for
 * `/help`, neither of which comes from Twitch.
 */
export function localNotice(tab: Tab, text: string): ChatMessage {
  return {
    id: "",
    channel: tab.channel,
    // Stamped like a real one, so it routes to the tab it was written for and
    // not to the other account's view of the same channel.
    account: tab.account,
    userId: "",
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
