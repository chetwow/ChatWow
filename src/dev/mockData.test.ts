import { describe, expect, it } from "vitest";
import { buildInitialMessages, mockBlockedMessage, mockTabs } from "./mockData";
import { messageLine, messageText } from "../lib/messageText";

describe("simulated channel events", () => {
  it("includes a Gigantify message with both normal and enlarged occurrences of the same emote", () => {
    const message = buildInitialMessages(mockTabs()).find((message) => message.login === "powerupfan")!;
    const emotes = message.segments.filter((segment) => segment.kind === "emote");
    expect(emotes).toHaveLength(2);
    expect(emotes[0].gigantified).toBeUndefined();
    expect(emotes[1].gigantified).toBe(true);
    expect(emotes[0].id).toBe(emotes[1].id);
    expect(messageText(message)).toBe("Gigantify power-up: normal Kappa then gigantic Kappa");
  });

  it("renders cheer tiers while preserving the original body for copies and replies", () => {
    const messages = buildInitialMessages(mockTabs());
    const tiers = messages.find((message) => message.login === "bitsfan")!;
    expect(tiers.segments.filter((segment) => segment.kind === "cheermote").map((segment) => segment.bits))
      .toEqual([1, 10, 100, 1000, 5000, 10000]);
    expect(messageText(tiers)).toBe("A little of every tier: Cheer1 cHeEr10 Cheer100 Cheer1000 Cheer5000 Cheer10000");
    expect(messageLine(tiers, false)).toBe(`BitsFan: ${messageText(tiers)}`);
    const ordinary = messages.find((message) => message.login === "cheertalk")!;
    expect(ordinary.segments.every((segment) => segment.kind === "text")).toBe(true);
  });

  it("keeps blocked messages private to the sending account and out of chat bodies", () => {
    const tabs = mockTabs();
    const tab = tabs.find((tab) => tab.account === "2")!;
    const message = mockBlockedMessage(tab, "testing BANPHRASE today")!;
    expect(message.account).toBe(tab.account);
    expect(message.channel).toBe(tab.channel);
    expect(message.kind).toBe("notice");
    expect(message.segments).toEqual([]);
    expect(message.systemMessage).toBe("AutoMod: your message was denied: testing BANPHRASE today");
    expect(mockBlockedMessage(tab, "an ordinary message")).toBeNull();
  });

  it("includes each event family in the initial history without waiting for random traffic", () => {
    const tabs = mockTabs();
    for (const tab of tabs) {
      const messages = buildInitialMessages(tabs).filter((message) =>
        message.account === tab.account && message.channel === tab.channel);
      const text = messages.map((message) => message.systemMessage).join("\n");
      for (const sample of ["cheered 100 Bits", "was banned", "timed out", "unbanned", "timeout for",
        "Shared chat started", "Shared chat updated", "Shared chat ended", "added as a VIP",
        "removed as a VIP", "added as a moderator", "removed as a moderator", "Hype Train started",
        "Hype Train progress", "Hype Train ended", "Shoutout sent", "Shoutout received",
        "held for review", "denied: testing banphrase", "was approved", "Subscribers-only mode enabled",
        "Subscribers-only mode disabled"]) expect(text).toContain(sample);
    }
  });
});
