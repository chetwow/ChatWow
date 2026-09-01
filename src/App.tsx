import { useEffect, useState, type CSSProperties } from "react";
import { TitleBar } from "./components/TitleBar";
import { TabBar } from "./components/TabBar";
import { ChatView } from "./components/ChatView";
import { AddChannelDialog } from "./components/AddChannelDialog";
import { FONT_SIZE_PX, SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { EmoteTooltip } from "./components/EmoteTooltip";
import { subscribeToBackend, useChat } from "./store/chat";

/** Nothing joined: just the way in. The button says what this is. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <button
        onClick={onAdd}
        className="rounded-md bg-accent px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim"
      >
        Join a channel
      </button>
    </div>
  );
}

export default function App() {
  const active = useChat((state) => state.active);
  const channels = useChat((state) => state.channels);
  const bootstrap = useChat((state) => state.bootstrap);

  const [showAdd, setShowAdd] = useState(false);
  // Which tab the settings dialog is open on, or null when it's closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const chatFontSize = useChat((state) => FONT_SIZE_PX[state.preferences.chatFontSize]);

  useEffect(() => {
    const unsubscribe = subscribeToBackend();
    void bootstrap();
    return () => {
      void unsubscribe.then((off) => off());
    };
  }, [bootstrap]);

  // Ctrl+K opens the channel switcher, matching the command-palette convention.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowAdd(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      // Chat reads its text size off this; everything else is fixed.
      style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}
      className="flex h-full flex-col overflow-hidden bg-surface"
      onContextMenu={(event) => event.preventDefault()}
    >
      <TitleBar onOpenSettings={setSettingsTab} />
      <TabBar onAdd={() => setShowAdd(true)} />

      {active ? (
        <ChatView key={active} channel={active} />
      ) : (
        channels.length === 0 && <EmptyState onAdd={() => setShowAdd(true)} />
      )}

      {showAdd && <AddChannelDialog onClose={() => setShowAdd(false)} />}
      {settingsTab && (
        <SettingsDialog
          tab={settingsTab}
          onChangeTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}
      <EmoteTooltip />
    </div>
  );
}
