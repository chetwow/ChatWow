import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({ IS_TAURI: false, MOCK_MODE: false, IS_MACOS: false, TITLE_BAR_PX: 32 }));
vi.mock("../lib/notify", () => ({ playMentionSound: vi.fn() }));

import { playMentionSound } from "../lib/notify";
import type { PinnedMessage, Tab } from "../types";
import { tabPin, useChat } from "./chat";

const room: Tab = { id: "room", kind: "channel", channel: "room", account: "1", avatarMode: "none", mention: null };
const other: Tab = { ...room, id: "other", account: "2" };
const listener: Tab = { ...room, id: "listener", kind: "mentions", channel: "" };
const pin: PinnedMessage = {
  id: "pin-1", pinnedBy: "Moderator", expiresAt: null,
  message: {
    id: "message-1", channel: "room", account: "", userId: "2", ts: 0,
    login: "alice", displayName: "Alice", color: "#ffffff", badges: [],
    segments: [{ kind: "text", text: "@you hello" }], isAction: false,
    isFirstMessage: false, kind: "chat", historical: false, systemMessage: null, replyTo: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ tabs: [room, other, listener], active: [room.id, null] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Pinned messages", () => {
  it("shares room content but dismisses only the selected tab", () => {
    const state = useChat.getState();
    state.receivePinnedMessages({ room: pin });
    state.dismissPinnedMessage(room.id);
    expect(tabPin(useChat.getState(), other.id)).toEqual(pin);
    expect(useChat.getState().dismissedPins).toEqual({ room: pin.id });
    expect(tabPin(useChat.getState(), listener.id)).toBeUndefined();
  });

  it("restores a dismissed pin and selects its tab in the correct pane", () => {
    useChat.setState({ preferences: { ...useChat.getState().preferences, splitLayout: "column", splitIndex: 1 },
      active: [room.id, listener.id] });
    const state = useChat.getState();
    state.receivePinnedMessages({ room: pin });
    state.dismissPinnedMessage(other.id);
    state.viewPinnedMessage(other.id);
    expect(useChat.getState().dismissedPins).toEqual({});
    expect(useChat.getState().active).toEqual([room.id, other.id]);
    expect(useChat.getState().focusedPane).toBe(1);
  });

  it("keeps duration updates dismissed but shows a new pin of the same message", () => {
    const state = useChat.getState();
    state.receivePinnedMessages({ room: pin });
    state.dismissPinnedMessage(room.id);
    state.receivePinnedMessages({ room: { ...pin, expiresAt: 20_000 } });
    expect(useChat.getState().dismissedPins.room).toBe(useChat.getState().pinnedMessages.room.id);
    state.receivePinnedMessages({ room: { ...pin, id: "pin-2" } });
    expect(useChat.getState().dismissedPins.room).not.toBe(useChat.getState().pinnedMessages.room.id);
  });

  it("removes unpinned and expired messages and cannot restore them", () => {
    const state = useChat.getState();
    state.receivePinnedMessages({ room: { ...pin, expiresAt: 2_000 } });
    state.dismissPinnedMessage(other.id);
    vi.setSystemTime(2_000);
    expect(tabPin(useChat.getState(), other.id)).toBeUndefined();
    state.expirePinnedMessages();
    state.viewPinnedMessage(other.id);
    expect(useChat.getState().pinnedMessages).toEqual({});
    expect(useChat.getState().active).toEqual([room.id, null]);
    state.receivePinnedMessages({ room: pin });
    state.receivePinnedMessages({});
    expect(tabPin(useChat.getState(), room.id)).toBeUndefined();
  });

  it("respects blocked users in both the panel and recovery menu", () => {
    useChat.getState().receivePinnedMessages({ room: pin });
    useChat.setState({ preferences: { ...useChat.getState().preferences, blockedUsers: ["alice"] } });
    expect(tabPin(useChat.getState(), room.id)).toBeUndefined();
    useChat.setState({ preferences: { ...useChat.getState().preferences, blockedUsers: [] } });
    expect(tabPin(useChat.getState(), room.id)).toEqual(pin);
  });

  it("never ingests pins into chat or listener logs and never notifies", () => {
    const before = useChat.getState();
    before.receivePinnedMessages({ room: pin });
    before.dismissPinnedMessage(room.id);
    const after = useChat.getState();
    for (const key of ["messages", "unread", "mentions", "mentionLog", "chatters"] as const) {
      expect(after[key]).toBe(before[key]);
    }
    expect(playMentionSound).not.toHaveBeenCalled();
  });

  it("forgets dismissal when a tab closes", () => {
    useChat.setState({ tabs: [room, other] });
    const state = useChat.getState();
    state.receivePinnedMessages({ room: pin });
    state.dismissPinnedMessage(room.id);
    state.requestCloseTab(room.id);
    expect(useChat.getState().dismissedPins.room).toBeUndefined();
    expect(tabPin(useChat.getState(), room.id)).toBeUndefined();
    expect(tabPin(useChat.getState(), other.id)).toEqual(pin);
  });
});
