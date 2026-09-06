import { beforeEach, describe, expect, it } from "vitest";
import { useInlineVideo } from "./inlineVideo";

describe("inline video ownership", () => {
  beforeEach(() => useInlineVideo.setState({ owner: null, tabId: null }));
  it("replaces the previous player and ignores its later cleanup", () => {
    const youtube = Symbol("YouTube");
    const twitch = Symbol("Twitch");
    useInlineVideo.getState().toggle(youtube);
    useInlineVideo.getState().toggle(twitch);
    useInlineVideo.getState().close(youtube);
    expect(useInlineVideo.getState().owner).toBe(twitch);
    useInlineVideo.getState().close(twitch);
    expect(useInlineVideo.getState().owner).toBeNull();
  });
  it("distinguishes identical URLs in separate link instances", () => {
    const first = Symbol("same URL");
    const second = Symbol("same URL");
    useInlineVideo.getState().toggle(first);
    useInlineVideo.getState().toggle(second);
    expect(useInlineVideo.getState().owner).toBe(second);
    useInlineVideo.getState().toggle(second);
    expect(useInlineVideo.getState().owner).toBeNull();
    useInlineVideo.getState().toggle(first);
    expect(useInlineVideo.getState().owner).toBe(first);
  });
  it("tracks the retained tab and clears it only with its owner", () => {
    const first = Symbol("first");
    const next = Symbol("next");
    useInlineVideo.getState().toggle(first, "tab-one");
    expect(useInlineVideo.getState().tabId).toBe("tab-one");
    useInlineVideo.getState().toggle(next, "tab-two");
    useInlineVideo.getState().close(first);
    expect(useInlineVideo.getState().tabId).toBe("tab-two");
    useInlineVideo.getState().close(next);
    expect(useInlineVideo.getState().tabId).toBeNull();
  });

});
