import { useEffect, useRef, useState } from "react";
import { loadYoutubeApi, openLink, type YoutubeVideo } from "../lib/youtube";

export function YoutubePlayer({ video, href, onClose }: {
  video: YoutubeVideo; href: string; onClose: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [browserError, setBrowserError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let failed = false;
    let player: { destroy(): void } | undefined;
    const fail = () => {
      if (disposed || failed) return;
      failed = true;
      window.clearTimeout(timeout);
      player?.destroy();
      player = undefined;
      if (!disposed) setStatus("failed");
    };
    const timeout = window.setTimeout(fail, 20000);
    void loadYoutubeApi().then((api) => {
      if (disposed || failed || !host.current) return;
      const mount = document.createElement("span");
      host.current.replaceChildren(mount);
      player = new api.Player(mount, {
        videoId: video.id, width: "100%", height: "100%",
        playerVars: { start: video.start, origin: window.location.origin, playsinline: 1, fs: 0 },
        events: {
          onReady: () => { window.clearTimeout(timeout); if (!disposed && !failed) setStatus("ready"); },
          onError: fail,
        },
      });
      const iframe = host.current.querySelector("iframe");
      if (iframe) {
        iframe.title = "YouTube video player";
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
      }
    }).catch(fail);
    return () => { disposed = true; window.clearTimeout(timeout); player?.destroy(); };
  }, [video.id, video.start]);

  return (
    <span className="my-2 block w-full max-w-[480px] rounded-md border border-line bg-surface-raised p-2 text-xs text-ink" onClick={(event) => event.stopPropagation()}>
      <span className="mb-2 flex items-center justify-between gap-2">
        <span>YouTube{status === "loading" ? " · Loading…" : ""}</span>
        <button className="text-ink-dim hover:text-ink" onClick={onClose} aria-label="Close YouTube player">Close</button>
      </span>
      {status === "failed" ? (
        <span role="alert" className="block">
          This video couldn’t be played inline. Open it in your browser?
          <span className="mt-2 flex gap-3">
            <button className="text-accent" onClick={() => {
              void openLink(href).then(onClose).catch(() => setBrowserError(true));
            }}>Open in browser</button>
            <button onClick={onClose}>Cancel</button>
          </span>
          {browserError && <span className="mt-2 block">Couldn’t open the browser. Copy the link address from its context menu.</span>}
        </span>
      ) : null}
      <span ref={host} className={status === "failed" ? "hidden" : "block aspect-video min-h-[200px] w-full"} />
    </span>
  );
}
