import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IS_TAURI } from "../lib/tauri";

/**
 * An emote image, served from the on-disk cache when there is one.
 *
 * `emote://` is handled in Rust: it answers from the cache directory and
 * downloads on a miss, so the second time an emote appears it never touches
 * the network. Anything that goes wrong there answers 404 and we fall back to
 * the CDN url, which is also what a plain browser (`npm run dev`) always uses.
 *
 * Keyed by provider id, never by name -- 7TV emotes are commonly aliased per
 * channel, so the same image can arrive under several names.
 */
function cachedSrc(provider: string, id: string, remote: string): string {
  if (!IS_TAURI || !id) return remote;
  if (provider !== "7tv" && provider !== "twitch") return remote;
  return convertFileSrc(`${provider}-${id}`, "emote");
}

export function EmoteImage({
  id,
  provider,
  url,
  name,
  className,
}: {
  id: string;
  provider: string;
  url: string;
  name: string;
  className?: string;
}) {
  // Keyed on the emote so a recycled row starts from the cache again rather
  // than inheriting the previous emote's fallback.
  const [failed, setFailed] = useState(false);
  const cached = cachedSrc(provider, id, url);
  const src = failed ? url : cached;

  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => {
        if (!failed && cached !== url) setFailed(true);
      }}
      className={className}
    />
  );
}
