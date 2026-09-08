import { InlinePlayerActions } from "./InlinePlayerActions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { twitchClipEmbed } from "../lib/twitchClips";
import { openLink } from "../lib/youtube";

export function TwitchClipPlayer({ clip, href, onClose }: {
  clip: string; href: string; onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [browserError, setBrowserError] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const viewport = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(400);
  const scale = Math.min(1, width / 400);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      // CSS zoom already scales the whole transcript; measure layout pixels
      // here so the embedded player doesn't apply that scale a second time.
      const available = element.clientWidth;
      if (available > 0) setWidth(available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt]);
  useEffect(() => {
    timer.current = window.setTimeout(() => setPrompt(true), 20000);
    return () => window.clearTimeout(timer.current);
  }, []);
  const showPrompt = () => {
    window.clearTimeout(timer.current);
    setPrompt(true);
  };
  return (
    <span className="chat-inline-clip my-2 block w-full max-w-[480px] rounded-md border border-line bg-surface-raised p-2 text-xs text-ink" onClick={(event) => event.stopPropagation()}>
      <span className="mb-2 flex items-center justify-between gap-2">
        <span>Twitch clip{loading && !prompt ? " · Loading…" : ""}</span>
        <InlinePlayerActions name="Twitch clip" onClose={onClose} onOpenBrowser={() => {
          void openLink(href).then(onClose).catch(() => setBrowserError(true));
        }} />
      </span>
      {browserError && <span role="alert" className="mb-2 block">Couldn’t open the browser. Copy the link address from its context menu.</span>}
      {prompt ? (
        <span role="alert" className="block">
          Clip not playing inline? Open it in your browser?
          <span className="mt-2 flex gap-3">
            <button className="text-accent" onClick={() => {
              void openLink(href).then(onClose).catch(() => setBrowserError(true));
            }}>Open in browser</button>
            <button onClick={onClose}>Cancel</button>
          </span>
        </span>
      ) : (
        <>
          <span ref={viewport} className="relative block w-full overflow-hidden" style={{ height: 300 * scale }}>
            <iframe
              title="Twitch clip player"
              src={twitchClipEmbed(clip, window.location.hostname)}
              className="absolute left-0 top-0 block h-[300px] origin-top-left border-0"
              // Keep Twitch's layout at least 400x300, scaling its controls and
              // video together when chat has less room. Resizing keeps playback.
              style={{ width: Math.max(400, width), transform: `scale(${scale})` }}
              allow="fullscreen 'none'"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => {
                // Clips have no playback events. This only means the frame loaded.
                window.clearTimeout(timer.current);
                setLoading(false);
              }}
              onError={showPrompt}
            />
          </span>
        </>
      )}
    </span>
  );
}
