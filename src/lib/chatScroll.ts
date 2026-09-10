/** Allow only rounding error at the live edge, not a whole message of leeway. */
export const CHAT_BOTTOM_TOLERANCE = 1;

/** Count fully hidden newer rows; clipped messages and collapsed blocked rows don't count. */
export function hasMessagesBelow(element: HTMLElement, transcript: HTMLElement, minimum = 3): boolean {
  const bottom = element.getBoundingClientRect().top + element.clientTop + element.clientHeight;
  let count = 0;
  for (let row = transcript.lastElementChild; row; row = row.previousElementSibling) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top < bottom) break;
    if (++count >= minimum) return true;
  }
  return false;
}

/** Track upward intent before the browser applies even a fractional wheel delta. */
export function bindChatScroll(
  element: HTMLElement,
  setPinned: (pinned: boolean) => void,
  onScroll: () => void,
  isPinned: () => boolean,
) {
  let leavingBottom = false;
  let previousTop = element.scrollTop;
  let previousHeight = element.clientHeight;
  let previousScrollHeight = element.scrollHeight;
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
    leavingBottom = event.deltaY < 0;
    if (leavingBottom) setPinned(false);
  };
  const scroll = () => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const wasPinned = isPinned();
    const layoutChanged = element.clientHeight !== previousHeight || element.scrollHeight !== previousScrollHeight;
    const movedUp = element.scrollTop < previousTop;
    previousTop = element.scrollTop;
    previousHeight = element.clientHeight;
    previousScrollHeight = element.scrollHeight;
    if (wasPinned || distance > CHAT_BOTTOM_TOLERANCE) leavingBottom = false;
    if (!leavingBottom && distance <= CHAT_BOTTOM_TOLERANCE) setPinned(true);
    // Composer transitions and late row measurements can create a gap before
    // the resize observer catches up. They must not turn off following. Wheel
    // intent already unpins above; upward scrollbar/keyboard moves also unpin
    // when layout is stable. Stationary/downward correction events keep following.
    else if (!wasPinned || (movedUp && !layoutChanged)) setPinned(false);
    onScroll();
  };
  element.addEventListener("wheel", wheel, { passive: true });
  element.addEventListener("scroll", scroll);
  return () => {
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("scroll", scroll);
  };
}
