import { describe, expect, it } from "vitest";
import { bindChatScroll, hasMessagesBelow } from "./chatScroll";

function messagesBelow(rows: { top: number; height: number }[], viewportBottom = 500) {
  let lastElementChild: object | null = null;
  for (const rect of rows) {
    lastElementChild = { getBoundingClientRect: () => rect, previousElementSibling: lastElementChild };
  }
  const viewport = {
    getBoundingClientRect: () => ({ top: 100 }), clientTop: 0, clientHeight: viewportBottom - 100,
  };
  return hasMessagesBelow(viewport as HTMLElement, { lastElementChild } as HTMLElement);
}

describe("jump to present visibility", () => {
  it("requires three fully hidden newer messages", () => {
    expect(messagesBelow([])).toBe(false);
    expect(messagesBelow([{ top: 510, height: 20 }])).toBe(false);
    const rows = [{ top: 499, height: 40 }, { top: 539, height: 20 }, { top: 559, height: 20 }];
    expect(messagesBelow(rows)).toBe(false); // The clipped row is still visible.
    expect(messagesBelow(rows, 499)).toBe(true); // Exactly at the edge is fully hidden.
  });
  it("uses actual row geometry for tall messages and resized or zoomed views", () => {
    const rows = [{ top: 400, height: 600 }, { top: 1000, height: 40 }, { top: 1040, height: 80 }];
    expect(messagesBelow(rows)).toBe(false);
    expect(messagesBelow(rows, 400)).toBe(true);
    expect(messagesBelow(rows, 1100)).toBe(false);
  });
  it("ignores collapsed blocked rows and messages above the viewport", () => {
    expect(messagesBelow([
      { top: -100, height: 20 }, { top: 500, height: 20 },
      { top: 520, height: 0 }, { top: 520, height: 20 }, { top: 540, height: 0 },
    ])).toBe(false);
    expect(messagesBelow([
      { top: 500, height: 20 }, { top: 520, height: 0 },
      { top: 520, height: 20 }, { top: 540, height: 20 }, { top: 560, height: 0 },
    ])).toBe(true);
  });
});

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
