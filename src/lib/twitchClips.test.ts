import { describe, expect, it } from "vitest";
import { twitchClip, twitchClipEmbed } from "./twitchClips";

describe("Twitch clips", () => {
  it.each([
    "https://clips.twitch.tv/HelpfulClip-abc_123?tt_content=url",
    "https://www.twitch.tv/streamer/clip/HelpfulClip-abc_123",
    "https://m.twitch.tv/streamer/clip/HelpfulClip-abc_123",
    "https://clips.twitch.tv/embed?clip=HelpfulClip-abc_123&parent=evil.example",
  ])("recognizes %s", (href) => expect(twitchClip(href)).toBe("HelpfulClip-abc_123"));
  it.each([
    "https://twitch.tv/streamer", "https://twitch.tv/videos/123",
    "https://clips.twitch.tv.evil.example/HelpfulClip", "javascript:alert(1)",
    "https://user@clips.twitch.tv/HelpfulClip", "https://clips.twitch.tv:8888/HelpfulClip",
    "https://clips.twitch.tv/embed", "https://clips.twitch.tv/HelpfulClip/extra",
    "https://twitch.tv/streamer/clip/%3Cscript%3E", "https://example.com/clip/HelpfulClip",
  ])("keeps non-clip links external: %s", (href) => expect(twitchClip(href)).toBeNull());
  it("builds a fixed-host embed with the real parent and no autoplay", () => {
    const clip = twitchClip("https://clips.twitch.tv/embed?clip=HelpfulClip&parent=evil.example")!;
    const url = new URL(twitchClipEmbed(clip, "localhost"));
    expect(url.origin).toBe("https://clips.twitch.tv");
    expect([...url.searchParams.entries()]).toEqual([
      ["clip", "HelpfulClip"], ["parent", "localhost"], ["autoplay", "false"],
    ]);
  });
});
