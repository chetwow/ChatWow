import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ receive: (_event: { payload: unknown }) => {}, stop: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, receive) => {
  native.receive = receive;
  return native.stop;
}) }));

beforeEach(() => vi.resetModules());

describe("window event handoff", () => {
  it("replays messages, moderation and tab changes across startup exactly once in order", async () => {
    const events = await import("./backendEvents");
    const received: unknown[] = [];
    for (const name of ["chat://messages", "chat://clear", "chat://tabs"]) {
      await events.backendListen(name, (event) => received.push(event.payload));
    }
    await events.startBackendEvents();
    const replay = [
      { sequence: 40, name: "chat://messages", payload: "message during native creation" },
      { sequence: 41, name: "chat://clear", payload: "moderated during startup" },
      { sequence: 42, name: "chat://tabs", payload: "moved tab" },
    ];
    // The child subscribed halfway through this gap, and queued duplicates.
    native.receive({ payload: replay[1] });
    native.receive({ payload: replay[2] });
    native.receive({ payload: { sequence: 43, name: "chat://messages", payload: "live after snapshot" } });
    expect(received).toEqual([]);
    events.finishBackendBootstrap({ data: {}, events: replay, through: 42 });
    expect(received).toEqual(["message during native creation", "moderated during startup", "moved tab", "live after snapshot"]);
    expect(events.backendCursor()).toBe(43);
    expect(events.backendHydrating()).toBe(false);
  });

  it("delivers events queued by the main window's ordinary bootstrap", async () => {
    const events = await import("./backendEvents");
    const received = vi.fn();
    await events.backendListen("chat://status", received);
    await events.startBackendEvents();
    native.receive({ payload: { sequence: 3, name: "chat://status", payload: "connected" } });
    events.finishBackendBootstrap({ data: null, events: [], through: 3 });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ payload: "connected" }));
  });
});
