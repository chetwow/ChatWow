import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { devBackendLifecycle } from "./backendLifecycle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);

it("cancels a StrictMode mount still attaching IPC listeners before bootstrapping its replacement", async () => {
  let attached!: (off: () => void) => void;
  const oldOff = vi.fn();
  const newOff = vi.fn();
  const subscribe = vi.fn<() => Promise<() => void>>()
    .mockImplementationOnce(() => new Promise((resolve) => { attached = resolve; }))
    .mockResolvedValue(newOff);
  const bootstrap = vi.fn(async () => {});
  const hydrate = vi.fn(async () => {});
  const start = devBackendLifecycle(subscribe, bootstrap, hydrate, vi.fn());
  const stopFirst = start();
  await flush();
  stopFirst();
  const stopSecond = start();
  await flush();
  expect(subscribe).toHaveBeenCalledTimes(1);
  attached(oldOff);
  await flush();
  expect(oldOff).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(bootstrap).toHaveBeenCalledOnce();
  expect(hydrate).toHaveBeenCalledOnce();
  stopSecond();
  await flush();
  expect(newOff).toHaveBeenCalledOnce();
});

it("retries failed bootstrap with fresh listeners, then restores metadata without reattaching sockets", async () => {
  const off = vi.fn();
  const subscribe = vi.fn(async () => off);
  const bootstrap = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("backend restarting"))
    .mockResolvedValue(undefined);
  const hydrate = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("snapshot unavailable"))
    .mockResolvedValue(undefined);
  const report = vi.fn();
  const stop = devBackendLifecycle(subscribe, bootstrap, hydrate, report)();
  await flush();
  expect(off).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(bootstrap).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(hydrate).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(2);
  stop();
  await flush();
  expect(off).toHaveBeenCalledTimes(2);
});

it("preserves cleanup ordering across a hot-replaced session module", async () => {
  const queue = { pending: Promise.resolve() };
  let finish!: () => void;
  const oldOff = vi.fn();
  const oldStart = devBackendLifecycle(async () => oldOff, async () => {},
    () => new Promise<void>((resolve) => { finish = resolve; }), vi.fn(), queue);
  const stopOld = oldStart();
  await flush();
  stopOld();
  const subscribe = vi.fn(async () => vi.fn());
  const stopNew = devBackendLifecycle(subscribe, async () => {}, async () => {}, vi.fn(), queue)();
  await flush();
  expect(subscribe).not.toHaveBeenCalled();
  finish();
  await flush();
  expect(oldOff).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledOnce();
  stopNew();
  await flush();
});
