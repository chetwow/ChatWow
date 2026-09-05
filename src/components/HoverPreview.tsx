import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTooltip } from "../store/tooltip";
import { loadPreviewImage } from "../lib/linkPreviews";
import type { LinkPreview } from "../types";

const LABEL: Record<string, string> = {
  twitch: "Twitch",
  "7tv": "7TV",
};

/** Clearance from the window edges, and from the thing being hovered. */
const MARGIN = 8;
const GAP = 8;
/** Pointer travel allowed after chat moves a held link away. */
const HELD_PREVIEW_SLOP_PX = 8;

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

const containsPoint = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** Squared distance from a point to the finite line segment `start` -> `end`. */
function distanceToSegmentSquared(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared === 0) {
    const x = point.x - start.x;
    const y = point.y - start.y;
    return x * x + y * y;
  }
  const progress = clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
    0,
    1,
  );
  const x = point.x - (start.x + progress * segmentX);
  const y = point.y - (start.y + progress * segmentY);
  return x * x + y * y;
}

/**
 * Shown while a preview is on its way -- which for an image is however long
 * the host takes to send it, and for a page is a request and a parse. Without
 * it the delay reads as nothing happening, and the picture arriving later
 * reads as a glitch.
 */
function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading preview"
      className="m-4 block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-ink-dim"
    />
  );
}

/**
 * The image behind a direct image link, held back until it has actually
 * arrived: an `<img>` with nothing decoded yet is a box of empty space, and
 * the frame would jump from that to full size. `display: none` still loads it.
 */
function ImageCard({
  url,
  alt,
  gif,
  onSettled,
  onFail,
}: {
  url: string;
  alt?: string;
  gif?: boolean;
  onSettled: () => void;
  onFail: () => void;
}) {
  const [ready, setReady] = useState(false);
  return (
    <>
      {!ready && <Spinner />}
      <img
        src={url}
        alt={alt ?? ""}
        decoding="async"
        referrerPolicy={gif ? "no-referrer" : undefined}
        onLoad={() => {
          setReady(true);
          onSettled();
        }}
        // A url that ends in `.png` and isn't one leaves an empty frame sitting
        // over chat, so it takes the preview down with it.
        onError={onFail}
        className={
          ready
            ? gif
              ? "chat-gif-preview object-contain"
              : "max-h-[min(320px,45vh)] max-w-[min(360px,60vw)] object-contain"
            : "hidden"
        }
      />
    </>
  );
}

/**
 * What a page says about itself: its thumbnail, its title, whatever labelled
 * rows it had (YouTube's channel, duration, views), then its own summary and
 * the host it lives on.
 *
 * The thumbnail is the one part allowed to fail quietly -- it's from whatever
 * CDN the page named, and the rest of the card is worth showing without it.
 */
function PageCard({
  preview,
  host,
  onSettled,
}: {
  preview: LinkPreview;
  host: string;
  onSettled: () => void;
}) {
  const [imageOk, setImageOk] = useState(true);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setImageOk(true);
    setImageUrl(null);
    if (preview.image) {
      void loadPreviewImage(preview.image).then((url) => {
        if (!current) return;
        setImageUrl(url);
        setImageOk(url !== null);
        onSettled();
      });
    }
    return () => {
      current = false;
    };
  }, [preview.image, onSettled]);

  return (
    <div className="w-[min(340px,70vw)] text-left">
      {imageUrl && imageOk && (
        <img
          src={imageUrl}
          alt=""
          onLoad={onSettled}
          onError={() => {
            setImageOk(false);
            onSettled();
          }}
          className="mb-1.5 max-h-[min(180px,28vh)] w-full rounded object-cover"
        />
      )}

      <div className="text-[12px] font-semibold leading-snug text-ink">{preview.title}</div>

      {preview.facts.length > 0 && (
        <div className="mt-1 flex flex-col gap-px">
          {preview.facts.map((fact) => (
            <div key={fact.label} className="flex gap-1.5 text-[11px] leading-snug">
              <span className="shrink-0 text-ink-faint">{fact.label}</span>
              <span className="min-w-0 truncate text-ink-dim">{fact.value}</span>
            </div>
          ))}
        </div>
      )}

      {preview.description && (
        // Three lines: enough for a real summary, short of turning the tooltip
        // into the page.
        <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-ink-dim">
          {preview.description}
        </div>
      )}

      <div className="mt-1 truncate text-[10px] text-ink-faint">{host}</div>
    </div>
  );
}

/**
 * The one hover preview: an emote at full size, the image a link points at, or
 * what the page behind a link says about itself.
 *
 * Positioned from a measurement rather than by CSS transforms alone. An emote
 * is small enough to centre on its anchor and be done with, but a link's card
 * is a third of the window across -- centred on a link near the edge it would
 * hang off the side, and hung above one in the top row it would sit off the
 * top.
 */
export function HoverPreview() {
  const preview = useTooltip((state) => state.preview);
  const anchor = useTooltip((state) => state.anchor);
  const holdUntilInput = useTooltip((state) => state.holdUntilInput);
  const heldSource = useTooltip((state) => state.heldSource);
  const heldOrigin = useTooltip((state) => state.heldOrigin);
  const hide = useTooltip((state) => state.hide);
  const box = useRef<HTMLDivElement>(null);
  /**
   * Bumped when a picture lands. Until then the frame is only as big as the
   * spinner, so the first measurement places a box that's about to grow.
   */
  const [settled, setSettled] = useState(0);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const resettle = useCallback(() => setSettled((count) => count + 1), []);

  useLayoutEffect(() => {
    if (!holdUntilInput || !heldSource || !heldOrigin) return;

    // A stationary pointer can lose its CSS hover when new chat moves the
    // link beneath it. That produces mouseleave, but not pointermove, so link
    // previews stay put through layout movement. Movement while the original
    // link is still beneath the pointer is harmless; once it is not, measure
    // from the last position that genuinely hovered the link and allow a
    // small amount of hand jitter before dismissing.
    let graceOrigin = heldOrigin;
    const onPointerMove = (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      const previewBox = box.current?.getBoundingClientRect();
      if (previewBox && containsPoint(previewBox, point.x, point.y)) {
        graceOrigin = point;
        return;
      }

      const underPointer = document.elementFromPoint(event.clientX, event.clientY);
      if (
        heldSource.isConnected &&
        underPointer &&
        (underPointer === heldSource || heldSource.contains(underPointer))
      ) {
        graceOrigin = point;
        return;
      }

      const toleranceSquared = HELD_PREVIEW_SLOP_PX * HELD_PREVIEW_SLOP_PX;
      if (previewBox) {
        // The popup is separated from its source by a visual gap. Keep a
        // narrow corridor from the last genuinely hovered point to the
        // nearest edge of the popup so crossing that gap remains possible.
        const previewEdge = {
          x: clamp(graceOrigin.x, previewBox.left, previewBox.right),
          y: clamp(graceOrigin.y, previewBox.top, previewBox.bottom),
        };
        if (distanceToSegmentSquared(point, graceOrigin, previewEdge) < toleranceSquared) return;
      }

      const x = point.x - graceOrigin.x;
      const y = point.y - graceOrigin.y;
      if (x * x + y * y >= toleranceSquared) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [holdUntilInput, heldSource, heldOrigin, hide]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) {
      setAt(null);
      return;
    }
    const { offsetWidth: width, offsetHeight: height } = element;
    const above = anchor.top - GAP - height;
    setAt({
      left: clamp(anchor.x - width / 2, MARGIN, window.innerWidth - width - MARGIN),
      // Above what you're hovering, where it covers what you've already read
      // rather than what you're about to. Below it only when it doesn't fit.
      top:
        above >= MARGIN
          ? above
          : clamp(anchor.bottom + GAP, MARGIN, window.innerHeight - height - MARGIN),
    });
  }, [preview, anchor, settled]);

  if (!preview) return null;

  return (
    <div
      ref={box}
      className="pointer-events-none fixed z-[60]"
      // Hidden until measured: one frame at the top-left corner otherwise.
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}
    >
      <div className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface-raised p-2 shadow-xl shadow-black/50">
        {preview.kind === "emote" ? (
          <>
            <img
              src={preview.urlLarge}
              alt={preview.name}
              className="h-16 max-w-none object-contain"
            />
            <div className="text-[11px] font-semibold text-ink">{preview.name}</div>
            <div className="text-[10px] text-ink-faint">
              {LABEL[preview.provider] ?? preview.provider}
              {preview.by && ` \u00b7 by ${preview.by}`}
            </div>
          </>
        ) : preview.kind === "loading" ? (
          <Spinner />
        ) : preview.kind === "page" ? (
          <PageCard
            // Keyed so a second link's card doesn't inherit the first's failed
            // thumbnail, or draw at its size while the new one loads.
            key={preview.host + preview.preview.title}
            preview={preview.preview}
            host={preview.host}
            onSettled={resettle}
          />
        ) : preview.kind === "message" ? (
          <div className="max-h-[min(160px,30vh)] w-[min(360px,70vw)] overflow-hidden whitespace-pre-wrap break-words text-left text-[11px] leading-relaxed text-ink">
            {preview.line}
          </div>
        ) : preview.kind === "gif" ? (
          <ImageCard
            key={preview.url}
            url={preview.url}
            alt={preview.alt}
            gif
            onSettled={resettle}
            onFail={hide}
          />
        ) : (
          <ImageCard key={preview.url} url={preview.url} onSettled={resettle} onFail={hide} />
        )}
      </div>
    </div>
  );
}
