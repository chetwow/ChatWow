import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmoteIndex, Tab } from "../types";

vi.mock("../lib/tauri", () => ({ IS_TAURI: true, MOCK_MODE: false, IS_MACOS: false }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import { api } from "../lib/api";
import { useChat } from "./chat";

const tab = (id: string, account = "first"): Tab => ({
  id, account, kind: "channel", channel: "room", avatarMode: "none", mention: null,
});
const index = (name: string, uses = 0): EmoteIndex => ({
  entries: [{ id: name, name, provider: "twitch", url: `https://example.com/${name}` }],
  uses: { Kappa: uses },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => useChat.setState(useChat.getInitialState(), true));
afterEach(() => vi.restoreAllMocks());

describe("account-specific channel state", () => {
  it("resets a remotely changed account and preserves ready/role events that beat the command response", async () => {
    const response = deferred<Tab[]>();
    vi.spyOn(api, "setTabAccount").mockReturnValue(response.promise);
    vi.spyOn(api, "emoteIndex").mockResolvedValue(index("NewEmote"));
    useChat.setState({ tabs: [tab("one"), tab("removed")], ready: { one: true }, roles: { one: "broadcaster" },
      emoteEntries: { one: index("OldEmote").entries } });

    const changing = useChat.getState().setTabAccount("one", "second");
    const changed = [tab("one", "second")];
    useChat.getState().receiveTabs(changed);
    expect(useChat.getState().roles.one).toBe("viewer");
    expect(useChat.getState().ready.one).toBe(false);
    expect(useChat.getState().emoteEntries.one).toBeUndefined();

    useChat.setState({ ready: { one: true }, roles: { one: "moderator" } });
    response.resolve(changed);
    await changing;
    expect(useChat.getState().roles.one).toBe("moderator");
    expect(useChat.getState().ready.one).toBe(true);
  });

  it("inherits an existing anonymous connection when signing out", () => {
    useChat.setState({ tabs: [tab("signed"), tab("anonymous", "")],
      ready: { signed: true, anonymous: true }, roles: { signed: "moderator", anonymous: "viewer" },
      emoteEntries: { signed: index("SubscriberOnly").entries, anonymous: index("Global").entries } });
    useChat.getState().setAuth(useChat.getInitialState().auth);
    expect(useChat.getState().tabs[0].account).toBe("");
    expect(useChat.getState().roles.signed).toBe("viewer");
    expect(useChat.getState().ready.signed).toBe(true);
    expect(useChat.getState().emoteEntries.signed).toEqual(index("Global").entries);
  });

  it("ignores emote responses from the previous account and from a closed tab", async () => {
    const old = deferred<EmoteIndex>();
    const closed = deferred<EmoteIndex>();
    vi.spyOn(api, "emoteIndex").mockReturnValueOnce(old.promise).mockReturnValueOnce(closed.promise);
    useChat.setState({ tabs: [tab("one")] });
    const loading = useChat.getState().loadEmoteIndex("one");
    useChat.getState().receiveTabs([tab("one", "second")]);
    old.resolve(index("SubscriberOnly", 20));
    await loading;
    expect(useChat.getState().emoteEntries.one).toBeUndefined();

    const loadingClosed = useChat.getState().loadEmoteIndex("one");
    useChat.getState().receiveTabs([]);
    // Reopening keeps the id; the old request still belongs to the closed view.
    useChat.getState().receiveTabs([tab("one", "second")]);
    closed.resolve(index("Obsolete", 30));
    await loadingClosed;
    expect(useChat.getState().emoteEntries.one).toBeUndefined();
  });

  it("retains the newest refresh and usage counts recorded while requests were pending", async () => {
    const older = deferred<EmoteIndex>();
    const newer = deferred<EmoteIndex>();
    vi.spyOn(api, "emoteIndex").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    useChat.setState({ tabs: [tab("one")] });
    const first = useChat.getState().loadEmoteIndex("one");
    const second = useChat.getState().loadEmoteIndex("one");
    useChat.setState({ emoteUses: { Kappa: 4 } });
    newer.resolve(index("NewSet", 3));
    await second;
    older.resolve(index("OldSet", 2));
    await first;
    expect(useChat.getState().emoteEntries.one).toEqual(index("NewSet").entries);
    expect(useChat.getState().emoteUses.Kappa).toBe(4);
  });
});
