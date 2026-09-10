import { useLayoutEffect, useRef, type RefObject } from "react";
import { bindTabScrollbar } from "../lib/tabScrollbar";

/** A sibling of the scrolling row, so the thumb itself never scrolls or adds a gutter. */
export function TabScrollbar({ scrollerRef, contentKey, controls }: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  contentKey: string;
  controls: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    const row = scroller?.parentElement;
    if (!scroller || !track || !thumb || !row) return;
    const scrollbar = bindTabScrollbar(row, scroller, track, thumb);
    const observer = new ResizeObserver(scrollbar.sync);
    observer.observe(scroller);
    // A rename or a newly added tab can change scrollWidth without resizing the viewport.
    for (const tab of scroller.children) observer.observe(tab);
    return () => { observer.disconnect(); scrollbar.dispose(); };
  }, [scrollerRef, contentKey]);
  return (
    <div ref={trackRef} className="tab-scrollbar" role="scrollbar" tabIndex={0}
      aria-label="Scroll tabs" aria-orientation="horizontal" aria-controls={controls}
      aria-valuemin={0}>
      <div ref={thumbRef} className="tab-scrollbar-thumb" />
    </div>
  );
}
