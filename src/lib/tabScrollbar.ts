export const TAB_SCROLLBAR_IDLE_MS = 1000;

/** Overlay geometry, including a usable thumb in very narrow split panels. */
export function tabScrollbarGeometry(viewport: number, content: number, scroll: number) {
  const maxScroll = Math.max(0, content - viewport);
  const width = content > 0 ? Math.min(viewport, Math.max(24, viewport * viewport / content)) : 0;
  const travel = Math.max(0, viewport - width);
  const left = maxScroll > 0 ? Math.max(0, Math.min(maxScroll, scroll)) / maxScroll * travel : 0;
  return { maxScroll, width, travel, left };
}

/** Own visibility explicitly: a stationary pointer over the row must not keep it awake. */
export function bindTabScrollbar(row: HTMLElement, scroller: HTMLElement, track: HTMLElement, thumb: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dragging: { pointer: number; grab: number } | null = null;
  let focused = false;
  const metrics = () => tabScrollbarGeometry(scroller.clientWidth, scroller.scrollWidth, scroller.scrollLeft);
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    clearTimer();
    track.dataset.visible = "false";
  };
  const wake = () => {
    clearTimer();
    if (track.hidden) return;
    track.dataset.visible = "true";
    if (!dragging && !focused) timer = setTimeout(hide, TAB_SCROLLBAR_IDLE_MS);
  };
  const sync = () => {
    const { maxScroll, width, left } = metrics();
    track.hidden = maxScroll <= 1;
    thumb.style.width = `${width}px`;
    thumb.style.transform = `translateX(${left}px)`;
    track.setAttribute("aria-valuemax", String(Math.round(maxScroll)));
    track.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(maxScroll, scroller.scrollLeft)))));
    if (track.hidden) hide();
  };
  const scroll = () => { sync(); wake(); };
  const moveThumb = (clientX: number) => {
    if (!dragging) return;
    const { width, travel, maxScroll } = metrics();
    const left = clientX - track.getBoundingClientRect().left - dragging.grab * width;
    scroller.scrollLeft = travel > 0 ? Math.max(0, Math.min(1, left / travel)) * maxScroll : 0;
    sync();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const { left, width } = metrics();
    const x = event.clientX - track.getBoundingClientRect().left;
    dragging = { pointer: event.pointerId, grab: x >= left && x <= left + width ? (x - left) / width : 0.5 };
    track.setPointerCapture(event.pointerId);
    wake();
    moveThumb(event.clientX);
  };
  const pointerMove = (event: PointerEvent) => {
    if (dragging?.pointer === event.pointerId) moveThumb(event.clientX);
  };
  const endDrag = () => {
    const pointer = dragging?.pointer;
    dragging = null;
    if (pointer !== undefined && track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
    wake();
  };
  const pointerEnd = (event: PointerEvent) => {
    if (dragging?.pointer === event.pointerId) endDrag();
  };
  const focus = () => { focused = true; wake(); };
  const blur = () => { focused = false; wake(); };
  const windowBlur = () => { focused = false; endDrag(); hide(); };
  const keyDown = (event: KeyboardEvent) => {
    let next = scroller.scrollLeft;
    switch (event.key) {
      case "ArrowLeft": next -= 40; break;
      case "ArrowRight": next += 40; break;
      case "PageUp": next -= scroller.clientWidth; break;
      case "PageDown": next += scroller.clientWidth; break;
      case "Home": next = 0; break;
      case "End": next = metrics().maxScroll; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    scroller.scrollLeft = Math.max(0, Math.min(metrics().maxScroll, next));
    scroll();
  };
  // Clicking the overlay must not select a tab or open a tab-bar menu.
  const stopClick = (event: Event) => event.stopPropagation();
  const view = scroller.ownerDocument.defaultView;
  row.addEventListener("pointerenter", wake);
  row.addEventListener("pointermove", wake);
  scroller.addEventListener("scroll", scroll);
  scroller.addEventListener("wheel", wake, { passive: true });
  track.addEventListener("pointerdown", pointerDown);
  track.addEventListener("pointermove", pointerMove);
  track.addEventListener("pointerup", pointerEnd);
  track.addEventListener("pointercancel", pointerEnd);
  track.addEventListener("lostpointercapture", pointerEnd);
  track.addEventListener("focus", focus);
  track.addEventListener("blur", blur);
  track.addEventListener("keydown", keyDown);
  track.addEventListener("click", stopClick);
  track.addEventListener("contextmenu", stopClick);
  view?.addEventListener("blur", windowBlur);
  sync();
  return {
    sync,
    dispose: () => {
      windowBlur();
      row.removeEventListener("pointerenter", wake);
      row.removeEventListener("pointermove", wake);
      scroller.removeEventListener("scroll", scroll);
      scroller.removeEventListener("wheel", wake);
      track.removeEventListener("pointerdown", pointerDown);
      track.removeEventListener("pointermove", pointerMove);
      track.removeEventListener("pointerup", pointerEnd);
      track.removeEventListener("pointercancel", pointerEnd);
      track.removeEventListener("lostpointercapture", pointerEnd);
      track.removeEventListener("focus", focus);
      track.removeEventListener("blur", blur);
      track.removeEventListener("keydown", keyDown);
      track.removeEventListener("click", stopClick);
      track.removeEventListener("contextmenu", stopClick);
      view?.removeEventListener("blur", windowBlur);
    },
  };
}
