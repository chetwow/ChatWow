import { describe, expect, it } from "vitest";
import { buildInitialMessages, mockBlockedMessage, mockTabs } from "./mockData";

describe("simulated channel events", () => {
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
