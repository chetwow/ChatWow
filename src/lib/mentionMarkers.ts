export type MentionMarkerLayout = {
  /** Scroll position that centers the row as closely as the transcript allows. */
  scrollTop: number;
  /** Marker position within the visible scrollbar-height overlay. */
  top: number;
};

/**
 * Map one measured message row onto the scrollbar track. The marker describes
 * the scroll position reached when that row is centered, so clicking the top
 * or bottom marker lands at the same extremes as dragging the thumb there.
 */
export function mentionMarkerLayout(
  rowTop: number,
  rowHeight: number,
  viewportHeight: number,
  scrollHeight: number,
  markerHeight: number,
): MentionMarkerLayout | null {
  const maxScroll = scrollHeight - viewportHeight;
  if (maxScroll <= 0 || viewportHeight <= 0 || markerHeight <= 0) return null;

  const desired = rowTop - (viewportHeight - rowHeight) / 2;
  const scrollTop = Math.min(maxScroll, Math.max(0, desired));
  const track = Math.max(0, viewportHeight - markerHeight);
  return {
    scrollTop,
    top: Math.round((scrollTop / maxScroll) * track),
  };
}

/** Whether the native scrollbar thumb currently covers this marker. */
export function markerUnderScrollbarThumb(
  markerTop: number,
  markerHeight: number,
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  minimumThumbHeight = 24,
): boolean {
  const maxScroll = scrollHeight - viewportHeight;
  if (maxScroll <= 0 || viewportHeight <= 0) return false;

  const thumbHeight = Math.min(
    viewportHeight,
    Math.max(minimumThumbHeight, (viewportHeight * viewportHeight) / scrollHeight),
  );
  const thumbTop = (scrollTop / maxScroll) * (viewportHeight - thumbHeight);
  return markerTop < thumbTop + thumbHeight && markerTop + markerHeight > thumbTop;
}
