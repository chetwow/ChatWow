import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";

export type BackendEvent = { sequence: number; name: string; payload: unknown };
export type WindowBootstrap = { data: Record<string, unknown> | null; events: BackendEvent[]; through: number };
const handlers = new Map<string, (event: TauriEvent<unknown>) => void>();
let cursor = 0;
let pending: BackendEvent[] | null = [];
export const backendCursor = () => cursor;
export const backendHydrating = () => pending !== null;

/** Register locally before attaching the one ordered native event stream. */
export async function backendListen<T>(name: string, handler: (event: TauriEvent<T>) => void) {
  handlers.set(name, handler as (event: TauriEvent<unknown>) => void);
  return () => { handlers.delete(name); };
}

function deliver(event: BackendEvent) {
  if (event.sequence <= cursor) return;
  handlers.get(event.name)?.({ event: event.name, id: event.sequence, payload: event.payload });
  cursor = event.sequence;
}

export async function startBackendEvents() {
  pending = [];
  return listen<BackendEvent>("window://event", ({ payload }) => {
    if (pending) pending.push(payload);
    else deliver(payload);
  });
}

/** Replay the transfer gap once, then release events queued during bootstrap. */
export function finishBackendBootstrap(bootstrap: WindowBootstrap) {
  if (bootstrap.data) {
    for (const event of bootstrap.events) deliver(event);
    cursor = Math.max(cursor, bootstrap.through);
  }
  for (const event of pending ?? []) deliver(event);
  pending = null;
}
