import { useEffect, useState } from "react";
import { loadPreviewImage } from "../lib/linkPreviews";
import { openLink } from "../lib/youtube";
import { InlinePlayerActions } from "./InlinePlayerActions";

export function InlineImage({ href, onClose }: { href: string; onClose: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [browserError, setBrowserError] = useState(false);
  useEffect(() => {
    let disposed = false;
    // Use the same bounded, public-network-only fetch as image previews.
    void loadPreviewImage(href).then((url) => {
      if (disposed) return;
      if (url) setSource(url);
      else setFailed(true);
    });
    return () => { disposed = true; };
  }, [href]);
  return (
    <span className="my-2 block w-full max-w-[480px] rounded-md border border-line bg-surface-raised p-2 text-xs text-ink" onClick={(event) => event.stopPropagation()}>
      <span className="mb-2 flex items-center justify-between gap-2">
        <span>{!loaded && !failed ? "Loading…" : ""}</span>
        <InlinePlayerActions name="image" closeLabel="Close inline image" onClose={onClose} onOpenBrowser={() => {
          void openLink(href).catch(() => setBrowserError(true));
        }} />
      </span>
      {browserError && <span role="alert" className="mb-2 block">Couldn’t open the browser. Copy the link address from its context menu.</span>}
      {failed ? <span role="alert" className="block">Couldn’t load this image. You can open it in your browser.</span> : source && (
        <img src={source} alt="Linked image" className="block max-h-[480px] max-w-full object-contain" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      )}
    </span>
  );
}
