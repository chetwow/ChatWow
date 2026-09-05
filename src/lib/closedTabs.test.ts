import { describe, expect, it } from "vitest";
import type { AuthStatus, Tab } from "../types";
import { restorableClosedTab, type ClosedTab } from "./closedTabs";

const auth = (ids: string[]): AuthStatus => ({
  hasClientId: true,
  clientIdOverride: null,
  accounts: ids.map((id) => ({ id, login: id, scopes: [], avatarUrl: "" })),
  defaultAccount: ids[0] ?? "",
  permissionGroups: [],
  permissionCatalog: [],
});

const channel = (account: string): Tab => ({
  id: "closed",
  kind: "channel",
  channel: "forsen",
  account,
  avatarMode: "account",
  mention: null,
});

const closed = (tab: Tab): ClosedTab => ({ tab, pane: 1, index: 2 });

describe("closed tab restoration", () => {
  it("reopens a removed account's channel anonymously", () => {
    expect(restorableClosedTab(closed(channel("gone")), auth(["here"]))?.tab.account).toBe("");
  });

  it("preserves a channel account that still exists", () => {
    expect(restorableClosedTab(closed(channel("here")), auth(["here"]))?.tab.account).toBe("here");
  });

  it("removes missing listener accounts when another criterion remains", () => {
    const tab: Tab = {
      ...channel("gone"),
      kind: "mentions",
      channel: "",
      mention: {
        name: "Watching",
        accounts: ["gone"],
        users: ["someone"],
        channels: ["forsen"],
        phrases: [],
        notify: true,
      },
    };
    const restored = restorableClosedTab(closed(tab), auth([]));
    expect(restored?.tab.account).toBe("");
    expect(restored?.tab.mention?.accounts).toEqual([]);
  });

  it("does not reopen an account-only listener after that account is removed", () => {
    const tab: Tab = {
      ...channel("gone"),
      kind: "mentions",
      channel: "",
      mention: {
        name: "Gone",
        accounts: ["gone"],
        users: [],
        channels: ["forsen"],
        phrases: [],
        notify: true,
      },
    };
    expect(restorableClosedTab(closed(tab), auth([]))).toBeNull();
  });
});
