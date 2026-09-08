import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
vi.mock("../lib/notify", () => ({ playMentionSound: vi.fn() }));

import type { ChatMessage, Tab } from "../types";
import { useChat } from "./chat";

const room: Tab = { id: "room", kind: "channel", channel: "room", account: "1", avatarMode: "none", mention: null };
const message = (id: string, kind: ChatMessage["kind"], patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, kind, channel: "room", account: "1", userId: "2", ts: 0,
  login: "alice", displayName: "Alice", color: "#ffffff", badges: [],
  segments: [{ kind: "text", text: "hello" }], isAction: false,
  isFirstMessage: false, historical: false, systemMessage: null, replyTo: null, ...patch,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ tabs: [room], active: [null, null] });
});
afterEach(() => vi.unstubAllGlobals());

describe("Tab unread counts", () => {
  it("counts live conversation in a mixed batch but keeps every row visible", () => {
    useChat.getState().ingest([
      message("disconnect", "notice", { systemMessage: "Disconnected from Twitch -- reconnecting" }),
      message("reconnect", "notice", { systemMessage: "Reconnected" }),
      message("subscription", "system", { systemMessage: "Alice subscribed!" }),
      message("chat", "chat"),
      message("action", "chat", { isAction: true }),
      message("whisper", "whisper", { channel: "" }),
      message("history", "chat", { historical: true }),
    ]);
    expect(useChat.getState().messages.room).toHaveLength(7);
    expect(useChat.getState().unread.room).toBe(3);
  });

  it("does not create or increase a badge for status and event rows", () => {
    useChat.getState().ingest([message("disconnect", "notice"), message("raid", "system")]);
    expect(useChat.getState().unread.room).toBeUndefined();
    useChat.setState({ unread: { room: 5 } });
    useChat.getState().ingest([message("reconnect", "notice")]);
    expect(useChat.getState().unread.room).toBe(5);
  });

  it("keeps all active panes read, including nested panels", () => {
    const second = { ...room, id: "second", channel: "second" };
    const third = { ...room, id: "third", channel: "third" };
    useChat.setState({ tabs: [room, second, third], active: { 0: room.id, 1: second.id, 4: third.id } });
    useChat.getState().ingest([
      message("chat", "chat"),
      message("other", "chat", { channel: "second" }),
      message("nested", "chat", { channel: "third" }),
      message("status", "notice"),
    ]);
    expect(useChat.getState().unread).toEqual({});
  });

  it("counts only conversation in listener badges without changing their event collection", () => {
    const listener: Tab = { ...room, id: "listener", kind: "mentions", channel: "",
      mention: { name: "Alice", accounts: [], users: ["alice"], channels: ["room"], phrases: [], notify: false } };
    useChat.setState({ tabs: [room, listener] });
    useChat.getState().ingest([
      message("subscription", "system", { systemMessage: "Alice subscribed!" }),
      message("chat", "chat"),
      message("history", "chat", { historical: true }),
    ]);
    expect(useChat.getState().mentionLog.listener).toHaveLength(2);
    expect(useChat.getState().unread.listener).toBe(1);
  });
});
