import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../types";

vi.mock("../lib/tauri", () => ({ IS_TAURI: true, MOCK_MODE: false, IS_MACOS: false }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import { api } from "../lib/api";
import { paneOf, panes, useChat } from "./chat";
import { localNotice } from "../lib/notice";

const channel = (id: string): Tab => ({ id, kind: "channel", channel: id, account: "", avatarMode: "none", mention: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ tabs: [channel("existing")], active: { 0: "existing" } });
  vi.spyOn(api, "setPreferences").mockResolvedValue(useChat.getState().preferences);
  vi.spyOn(api, "reorderTabs").mockImplementation(async () => useChat.getState().tabs);
});
afterEach(() => vi.restoreAllMocks());

describe("native tab command response ordering", () => {
  it("does not resurrect a closed tab or revert a newer edit when an older command response arrives", async () => {
    const existing = channel("existing");
    const closed = channel("closed");
    useChat.setState({ tabs: [existing, closed] });
    const response = deferred<Tab[]>();
    vi.spyOn(api, "setTabAvatarMode").mockReturnValue(response.promise);
    const changing = useChat.getState().setTabAvatarMode("existing", "owner");
    useChat.getState().receiveTabs([{ ...existing, avatarMode: "account", autohideComposer: true }]);
    response.resolve([{ ...existing, avatarMode: "owner" }, closed]);
    await changing;
    expect(useChat.getState().tabs).toEqual([{ ...existing, avatarMode: "account", autohideComposer: true }]);
  });

  it.each(["event first", "response first", "unrelated event first"])(
    "places a new tab once in the requested split with %s", async (order) => {
      useChat.getState().split(0, "right");
      const response = deferred<Tab[]>();
      const add = vi.spyOn(api, "addTab").mockReturnValue(response.promise);
      const opening = useChat.getState().openTab("channel", "newroom");
      const created = add.mock.calls[0][0];
      const tabs = [channel("existing"), created];
      if (order === "event first") useChat.getState().receiveTabs(tabs);
      if (order === "unrelated event first") useChat.getState().receiveTabs([channel("existing")]);
      response.resolve(tabs);
      await opening;
      if (order === "unrelated event first") {
        expect(useChat.getState().tabs.some((tab) => tab.id === created.id)).toBe(false);
        useChat.getState().receiveTabs(tabs);
      }
      expect(paneOf(useChat.getState(), created.id)).toBe(1);
      expect(useChat.getState().active[1]).toBe(created.id);
      useChat.getState().setActive("existing", 0);
      useChat.getState().receiveTabs(tabs);
      expect(useChat.getState().focusedPane).toBe(0);
    },
  );

  it.each(["closed", "transferred"])("does not revive or focus a newly %s tab from its delayed add response", async (outcome) => {
    const response = deferred<Tab[]>();
    const add = vi.spyOn(api, "addTab").mockReturnValue(response.promise);
    const opening = useChat.getState().openTab("channel", "newroom");
    const created = add.mock.calls[0][0];
    const tabs = [channel("existing"), created];
    if (outcome === "closed") {
      useChat.getState().receiveTabs(tabs);
      useChat.getState().receiveTabs([channel("existing")]);
    } else useChat.getState().receiveTabs([channel("existing"), { ...created, windowLabel: "child" }]);
    response.resolve(tabs);
    await opening;
    expect(useChat.getState().active[0]).toBe("existing");
    expect(useChat.getState().tabs.find((tab) => tab.id === created.id)?.windowLabel)
      .toBe(outcome === "closed" ? undefined : "child");
    if (outcome === "closed") expect(useChat.getState().tabs).toHaveLength(1);
  });

  it("clears pending placement when creation fails", async () => {
    const response = deferred<Tab[]>();
    const add = vi.spyOn(api, "addTab").mockReturnValue(response.promise);
    const opening = useChat.getState().openTab("channel", "newroom");
    const created = add.mock.calls[0][0];
    response.reject(new Error("creation failed"));
    await expect(opening).rejects.toThrow("creation failed");
    useChat.getState().receiveTabs([channel("existing"), created]);
    expect(useChat.getState().active[0]).toBe("existing");
  });

  it("closes an empty split when the removal event arrives after the close response", async () => {
    useChat.setState({ preferences: { ...useChat.getState().preferences, autoCloseEmptySplits: true } });
    useChat.getState().split(0, "right", "existing");
    const response = deferred<Tab[]>();
    vi.spyOn(api, "closeTab").mockReturnValue(response.promise);
    useChat.getState().requestCloseTab("existing");
    useChat.getState().receiveTabs([channel("existing")]);
    response.resolve([]);
    await response.promise;
    await Promise.resolve();
    expect(panes(useChat.getState())).toEqual([0, 1]);
    useChat.getState().receiveTabs([]);
    expect(panes(useChat.getState())).toEqual([0]);
    expect(useChat.getState().lastClosedTab?.tab.id).toBe("existing");
  });

  it.each(["live", "closed"])("does not reset or recreate a %s listener log after the add response", async (outcome) => {
    const response = deferred<Tab[]>();
    const add = vi.spyOn(api, "addTab").mockReturnValue(response.promise);
    const opening = useChat.getState().openMentionsTab({ name: "Viewer", users: ["viewer"],
      channels: ["existing"], accounts: [], phrases: [], notify: false });
    const created = add.mock.calls[0][0];
    const tabs = [channel("existing"), created];
    useChat.getState().receiveTabs(tabs);
    useChat.getState().ingest([{ ...localNotice(channel("existing"), "hello"),
      id: "arrived-before-response", kind: "chat", login: "viewer", displayName: "Viewer" }]);
    if (outcome === "closed") useChat.getState().receiveTabs([channel("existing")]);
    response.resolve(tabs);
    await opening;
    expect(useChat.getState().mentionLog[created.id]?.map((message) => message.id))
      .toEqual(outcome === "live" ? ["arrived-before-response"] : undefined);
  });

  it("restores reopened tab settings after its delayed creation event", async () => {
    const closed = { ...channel("reopened"), autohideComposer: true };
    useChat.setState({ lastClosedTab: { tab: closed, pane: 0, index: 0 } });
    const response = deferred<Tab[]>();
    vi.spyOn(api, "addTab").mockReturnValue(response.promise);
    const created = { ...closed, avatarMode: "owner" as const, autohideComposer: null };
    const avatar = vi.spyOn(api, "setTabAvatarMode").mockResolvedValue([
      channel("existing"), { ...created, avatarMode: "none" },
    ]);
    const autohide = vi.spyOn(api, "setTabAutohideComposer").mockResolvedValue([channel("existing"), closed]);
    const opening = useChat.getState().reopenLastClosedTab();
    useChat.getState().receiveTabs([channel("existing")]);
    response.resolve([channel("existing"), created]);
    await opening;
    expect(avatar).not.toHaveBeenCalled();
    useChat.getState().receiveTabs([channel("existing"), created]);
    await vi.waitFor(() => expect(autohide).toHaveBeenCalledWith("reopened", true));
    expect(avatar).toHaveBeenCalledWith("reopened", "none");
    expect(useChat.getState().tabs.find((tab) => tab.id === "reopened")).toEqual(closed);
    expect(useChat.getState().active[0]).toBe("reopened");
  });
});
