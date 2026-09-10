import { describe, expect, it } from "vitest";
import { bindChatScroll } from "./chatScroll";

function setup() {
  const element = Object.assign(new EventTarget(), {
    scrollHeight: 1000, clientHeight: 500, scrollTop: 500,
  });
  let pinned = true;
  const dispose = bindChatScroll(element as unknown as HTMLElement, (value) => { pinned = value; }, () => {}, () => pinned);
  const wheel = (deltaY: number, modifiers = {}) => element.dispatchEvent(
    Object.assign(new Event("wheel"), { deltaY, ctrlKey: false, metaKey: false, ...modifiers }),
  );
  const scroll = (distance: number) => {
    element.scrollTop = 500 - distance;
    element.dispatchEvent(new Event("scroll"));
  };
  return { wheel, scroll, dispose, jump: () => { pinned = true; scroll(0); }, pinned: () => pinned };
}

describe("chat scroll pinning", () => {
  it("pauses on the first tiny upward gesture before scrolling, and stays paused near the bottom", () => {
    const chat = setup();
    chat.wheel(-0.25);
    expect(chat.pinned()).toBe(false);
    chat.scroll(0);
    expect(chat.pinned()).toBe(false);
    chat.scroll(0.25);
    expect(chat.pinned()).toBe(false);
    chat.scroll(5);
    expect(chat.pinned()).toBe(false);
    chat.scroll(39);
    expect(chat.pinned()).toBe(false);
  });
  it("resumes at the bottom after scrolling back down, including a fractional reversal", () => {
    const chat = setup();
    chat.wheel(-0.25);
    chat.scroll(0.25);
    chat.wheel(0.25);
    chat.scroll(0);
    expect(chat.pinned()).toBe(true);
    chat.wheel(-10);
    chat.scroll(10);
    chat.scroll(0.5); // Scrollbar or keyboard can also return to the live edge.
    expect(chat.pinned()).toBe(true);
  });
  it("honors an explicit jump to present during a fractional upward gesture", () => {
    const chat = setup();
    chat.wheel(-0.25);
    chat.scroll(0.25);
    chat.jump();
    expect(chat.pinned()).toBe(true);
  });
  it("leaves zoom and horizontal gestures alone and removes listeners on cleanup", () => {
    const chat = setup();
    chat.wheel(-10, { ctrlKey: true });
    chat.wheel(-10, { metaKey: true });
    chat.wheel(0);
    expect(chat.pinned()).toBe(true);
    chat.dispose();
    chat.wheel(-10);
    chat.scroll(20);
    expect(chat.pinned()).toBe(true);
  });
});
