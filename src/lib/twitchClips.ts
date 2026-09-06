/** Clip-only recognition: never embed a chatter-selected host or arbitrary path. */
export function twitchClip(href: string): string | null {
  try {
    const url = new URL(href);
    if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) return null;
    const host = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    let clip: string | null = null;
    if (host === "clips.twitch.tv") {
      if (parts.length === 1 && parts[0] !== "embed") clip = parts[0];
      else if (url.pathname === "/embed") clip = url.searchParams.get("clip");
    } else if (["twitch.tv", "m.twitch.tv"].includes(host) && parts.length === 3 && parts[1] === "clip") {
      clip = parts[2];
    }
    return clip && /^[A-Za-z0-9_-]+$/.test(clip) ? clip : null;
  } catch {
    return null;
  }
}

export function twitchClipEmbed(clip: string, parent: string): string {
  const url = new URL("https://clips.twitch.tv/embed");
  url.search = new URLSearchParams({ clip, parent, autoplay: "false" }).toString();
  return url.href;
}
