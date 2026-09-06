import { describe, expect, it } from "vitest";
import { youtubeVideo } from "./youtube";

describe("YouTube video links", () => {
  it.each([
    "https://www.youtube.com/watch?v=qMpBobAonKs&list=abc",
    "https://youtu.be/qMpBobAonKs?si=abc",
    "https://m.youtube.com/shorts/qMpBobAonKs",
    "https://youtube.com/live/qMpBobAonKs",
    "https://www.youtube-nocookie.com/embed/qMpBobAonKs",
  ])("recognizes %s", (href) => {
    expect(youtubeVideo(href)).toEqual({ id: "qMpBobAonKs", start: 0 });
  });
  it.each([
    "https://youtube.com.evil.example/watch?v=qMpBobAonKs",
    "https://evil.example/youtu.be/qMpBobAonKs",
    "javascript:alert(1)",
    "https://youtube.com/@channel",
    "https://youtube.com/playlist?list=abc",
    "https://youtube.com/watch?v=bad",
    "https://youtube.com:9999/watch?v=qMpBobAonKs",
    "https://user@youtube.com/watch?v=qMpBobAonKs",
    "https://youtu.be/qMpBobAonKs/extra",
  ])("leaves non-video or untrusted links external: %s", (href) => {
    expect(youtubeVideo(href)).toBeNull();
  });
  it.each([["?t=1h2m3s", 3723], ["?start=62", 62], ["#t=90", 90], ["?t=-1", 0], ["?t=garbage", 0]])("preserves valid timestamps %s", (suffix, start) => {
    expect(youtubeVideo(`https://youtu.be/qMpBobAonKs${suffix}`)?.start).toBe(start);
  });
});

describe("lazy YouTube API loader", () => {
  it("shares an in-flight load and allows a fresh attempt after network failure", async () => {
    const { vi } = await import("vitest");
    const { loadYoutubeApi } = await import("./youtube");
    const scripts: Array<{ onerror?: () => void; remove: () => void }> = [];
    const fakeWindow: { YT?: object; onYouTubeIframeAPIReady?: () => void; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
      setTimeout, clearTimeout,
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", {
      createElement: () => ({ remove: vi.fn() }),
      head: { append: (script: typeof scripts[number]) => scripts.push(script) },
    });
    try {
      const first = loadYoutubeApi();
      expect(loadYoutubeApi()).toBe(first);
      expect(scripts).toHaveLength(1);
      const failure = expect(first).rejects.toThrow("could not load");
      scripts[0].onerror?.();
      await failure;
      expect(scripts[0].remove).toHaveBeenCalledOnce();
      const retry = loadYoutubeApi();
      expect(scripts).toHaveLength(2);
      const api = { Player: class {} };
      fakeWindow.YT = api;
      fakeWindow.onYouTubeIframeAPIReady?.();
      expect(await retry).toBe(api);
      expect(await loadYoutubeApi()).toBe(api);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
