import { useEffect, useState, type CSSProperties } from "react";
import { TitleBar } from "./components/TitleBar";
import { TabBar } from "./components/TabBar";
import { ChatView } from "./components/ChatView";
import { AddChannelDialog } from "./components/AddChannelDialog";
import { FONT_SIZE_PX, SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { EmoteTooltip } from "./components/EmoteTooltip";
import { subscribeToBackend, useChat } from "./store/chat";

/**
 * Nothing joined: the ways in, and nothing else. Signing in is offered
 * alongside because the title bar's own button is easy to miss on a screen
 * that's otherwise empty -- but it stays secondary, since reading a channel
 * doesn't need an account.
 */
function EmptyState({ onAdd, onSignIn }: { onAdd: () => void; onSignIn: () => void }) {
  const loggedIn = useChat((state) => state.auth.loggedIn);
  return (
    <div className="flex flex-1 items-center justify-center gap-2">
      <button
        onClick={onAdd}
        className="rounded-md bg-accent px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-accent-dim"
      >
        Join a channel
      </button>
      {!loggedIn && (
        <button
          onClick={onSignIn}
          className="rounded-md border border-line px-4 py-2 text-[12px] font-semibold text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Sign in
        </button>
      )}
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

  // Ctrl+K opens the channel switcher, matching the command-palette
  // convention. Ctrl/Cmd+T and Ctrl/Cmd+W are the browser's new-tab and
  // close-tab, which is what a row of tabs sets people up to expect --
  // reaching the page at all on macOS took dropping Close Window from the menu
  // bar (see `macos_menu` in src-tauri/src/lib.rs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setShowAdd(true);
        return;
      }
      // A dialog is its own context: closing the channel behind it, unseen,
      // isn't what Cmd+W means while you're looking at settings.
      if (document.querySelector("[data-modal]")) return;
      if (key === "t") {
        event.preventDefault();
        setShowAdd(true);
      } else if (key === "w") {
        event.preventDefault();
        const { active: channel, part } = useChat.getState();
        if (channel) void part(channel);
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
        channels.length === 0 && (
          <EmptyState onAdd={() => setShowAdd(true)} onSignIn={() => setSettingsTab("account")} />
        )
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
