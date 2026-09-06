export type DevBackendQueue = { pending: Promise<void> };

/** Serialize development remounts, including their asynchronous IPC cleanup. */
export function devBackendLifecycle(
  subscribe: () => Promise<() => void>,
  bootstrap: () => Promise<void>,
  hydrate: () => Promise<void>,
  report: (error: unknown) => void,
  queue: DevBackendQueue = { pending: Promise.resolve() },
) {
  return () => {
    const previous = queue.pending;
    let stopped = false;
    let wake = () => {};
    const wait = () => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      wake = () => { clearTimeout(timer); resolve(); };
      if (stopped) wake();
    });
    const run = async () => {
      await previous;
      let off: (() => void) | undefined;
      try {
        while (!stopped) {
          try {
            off = await subscribe();
            if (stopped) break;
            await bootstrap();
            break;
          } catch (error) {
            off?.(); off = undefined;
            report(error);
            await wait();
          }
        }
        while (!stopped) {
          try { await hydrate(); } catch (error) { report(error); }
          await wait();
        }
      } finally { off?.(); }
    };
    queue.pending = run().catch(report);
    return () => { stopped = true; wake(); };
  };
}
