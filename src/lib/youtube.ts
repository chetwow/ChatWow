import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_TAURI } from "./tauri";

export type YoutubeVideo = { id: string; start: number };

/** Recognize video URLs without contacting YouTube or accepting lookalike hosts. */
export function youtubeVideo(href: string): YoutubeVideo | null {
  try {
    const url = new URL(href);
    if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) return null;
    const host = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    let id: string | null = null;
    if (host === "youtu.be" && parts.length === 1) id = parts[0];
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else if (parts.length === 2 && ["shorts", "live", "embed"].includes(parts[0])) id = parts[1];
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const time = url.searchParams.get("t") ?? url.searchParams.get("start") ?? new URLSearchParams(url.hash.slice(1)).get("t") ?? "0";
    const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
    const start = /^\d+$/.test(time) ? Number(time) : duration
      ? Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) : 0;
    return { id, start: Number.isSafeInteger(start) ? Math.min(start, 2147483647) : 0 };
  } catch {
    return null;
  }
}

export async function openLink(href: string): Promise<void> {
  if (IS_TAURI) await openUrl(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

type Player = { destroy(): void };
type PlayerOptions = {
  videoId: string;
  width: string;
  height: string;
  playerVars: { start: number; origin: string; playsinline: number; fs: 0 | 1 };
  events: { onReady(): void; onError(): void };
};
type YoutubeApi = { Player: new (element: HTMLElement, options: PlayerOptions) => Player };
declare global {
  interface Window { YT?: YoutubeApi; onYouTubeIframeAPIReady?: () => void }
}
let apiPromise: Promise<YoutubeApi> | undefined;

/** Load once, only after a reader clicks an opted-in video. Failed loads can be retried. */
export function loadYoutubeApi(): Promise<YoutubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YoutubeApi>((resolve, reject) => {
    const script = document.createElement("script");
    const previous = window.onYouTubeIframeAPIReady;
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      window.onYouTubeIframeAPIReady = previous;
      if (error) { script.remove(); reject(error); }
      else if (window.YT) resolve(window.YT);
    };
    const timeout = window.setTimeout(() => finish(new Error("YouTube did not load")), 15000);
    window.onYouTubeIframeAPIReady = () => { finish(); previous?.(); };
    script.src = "https://www.youtube.com/iframe_api";
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onerror = () => finish(new Error("YouTube could not load"));
    document.head.append(script);
  }).catch((error: unknown) => { apiPromise = undefined; throw error; });
  return apiPromise;
}
