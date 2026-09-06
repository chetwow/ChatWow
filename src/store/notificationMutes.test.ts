import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
vi.mock("../lib/notify", () => ({ playMentionSound: vi.fn() }));

import { playMentionSound } from "../lib/notify";
import type { ChatMessage, Tab } from "../types";
import { useChat } from "./chat";

const room: Tab = { id: "room", kind: "channel", channel: "room", account: "1", avatarMode: "none", mention: null };
const listener: Tab = {
  ...room, id: "listener", kind: "mentions", channel: "",
  mention: { name: "Watched", accounts: ["1"], users: ["alice"], channels: ["room"], phrases: ["keyword"], notify: true },
};
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "message", channel: "room", account: "1", userId: "2", ts: 0,
  login: "alice", displayName: "Alice", color: "#ffffff", badges: [],
  segments: [{ kind: "text", text: "@you hello" }], isAction: false,
  isFirstMessage: false, kind: "chat", historical: false, systemMessage: null,
  replyTo: null, ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({
    tabs: [room, listener],
    auth: { ...useChat.getState().auth, accounts: [{ id: "1", login: "you", scopes: [], avatarUrl: "" }] },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Notification mute rules", () => {
  it.each(["@alice", "#room"])("%s silences channel and listener sounds but preserves visual notifications", (rule) => {
    useChat.getState().setNotificationMuted(rule, true);
    useChat.getState().ingest([message()]);
    expect(playMentionSound).not.toHaveBeenCalled();
    const state = useChat.getState();
    expect(state.messages.room).toHaveLength(1);
    expect(state.mentionLog.listener).toHaveLength(1);
    expect(state.mentions).toEqual({ room: 1, listener: 1 });
    expect(state.unread).toEqual({ room: 1, listener: 1 });
    expect(state.preferences.mentionIgnores).toEqual([]);
    state.setNotificationMuted(rule, false);
    state.ingest([message({ id: "next" })]);
    expect(playMentionSound).toHaveBeenCalledTimes(1);
  });

  it("normalizes and persists rules independently of ignores", () => {
    useChat.getState().updatePreferences({ notificationMutes: [" Alice ", "@ALICE", "#ROOM", "bad name"] });
    expect(useChat.getState().preferences.notificationMutes).toEqual(["#room", "@alice"]);
    const calls = vi.mocked(localStorage.setItem).mock.calls;
    expect(JSON.parse(calls[calls.length - 1][1]).notificationMutes).toEqual(["#room", "@alice"]);
    useChat.getState().setMentionIgnored("@alice", true);
    useChat.getState().ingest([message()]);
    expect(useChat.getState().messages.room).toHaveLength(1);
    expect(useChat.getState().mentionLog.listener).toBeUndefined();
    expect(useChat.getState().mentions.room).toBeUndefined();
    expect(playMentionSound).not.toHaveBeenCalled();
  });

  it("channel mutes do not silence whispers, but user mutes do across legacy listeners", () => {
    useChat.setState({ tabs: [room, { ...listener, mention: null }], active: ["room", null] });
    useChat.getState().setNotificationMuted("#room", true);
    useChat.getState().ingest([message({ channel: "", kind: "whisper" })]);
    expect(playMentionSound).toHaveBeenCalledTimes(1);
    vi.mocked(playMentionSound).mockClear();
    useChat.getState().setNotificationMuted("@alice", true);
    useChat.getState().ingest([message({ id: "next", channel: "", kind: "whisper" })]);
    expect(playMentionSound).not.toHaveBeenCalled();
    expect(useChat.getState().mentionLog.listener).toHaveLength(2);
  });

  it("mutes followed-user and phrase matches even without a mention", () => {
    useChat.getState().setNotificationMuted("#room", true);
    useChat.getState().ingest([
      message({ segments: [{ kind: "text", text: "hello" }] }),
      message({ id: "phrase", login: "bob", segments: [{ kind: "text", text: "keyword" }] }),
    ]);
    expect(playMentionSound).not.toHaveBeenCalled();
    expect(useChat.getState().mentionLog.listener).toHaveLength(2);
    expect(useChat.getState().mentions.listener).toBe(2);
  });

  it("still sounds once for an unmuted sender in a mixed batch", () => {
    useChat.getState().setNotificationMuted("@alice", true);
    useChat.getState().ingest([message(), message({ id: "other", login: "bob" })]);
    expect(playMentionSound).toHaveBeenCalledTimes(1);
    expect(useChat.getState().mentions.room).toBe(2);
  });
});
