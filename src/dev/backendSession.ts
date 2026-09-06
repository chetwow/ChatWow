// Dynamically imported only by the Tauri development webview.
import { invoke } from "@tauri-apps/api/core";
import { subscribeToBackend, useChat } from "../store/chat";
import type { Badge, ChannelRole, ConnectionState } from "../types";
import { devBackendLifecycle, type DevBackendQueue } from "./backendLifecycle";

type Snapshot = {
  ready: Record<string, boolean>;
  roles: Record<string, ChannelRole>;
  emoteCounts: Record<string, number>;
  connections: Record<string, ConnectionState>;
  globalEmotes: number;
  seventvBadges: Record<string, Badge>;
};

async function hydrate() {
  const snapshot = await invoke<Snapshot>("dev_chat_snapshot");
  const state = useChat.getState();
  const patch: Partial<Snapshot> = {};
  for (const key of Object.keys(snapshot) as (keyof Snapshot)[]) {
    if (JSON.stringify(snapshot[key]) !== JSON.stringify(state[key])) {
      Object.assign(patch, { [key]: snapshot[key] });
    }
  }
  if (Object.keys(patch).length > 0) useChat.setState(patch);
  for (const tab of state.tabs) {
    if (snapshot.ready[tab.id] && !state.emoteEntries[tab.id]) {
      await useChat.getState().loadEmoteIndex(tab.id);
    }
  }
}

// Carry cleanup ordering across edits to this module itself as well as App remounts.
const queue: DevBackendQueue = import.meta.hot?.data.queue ?? { pending: Promise.resolve() };
const start = devBackendLifecycle(
  subscribeToBackend,
  () => useChat.getState().bootstrap(),
  hydrate,
  (error) => console.warn("Development chat state sync will retry", error),
  queue,
);
let activeStop: (() => void) | undefined;
export function startDevBackend() {
  activeStop?.();
  activeStop = start();
  return activeStop;
}
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    activeStop?.();
    data.queue = queue;
  });
}
