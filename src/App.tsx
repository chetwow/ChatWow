import { useEffect, useState, type CSSProperties } from "react";
import { TitleBar } from "./components/TitleBar";
import { Panes } from "./components/Panes";
import { AddChannelDialog } from "./components/AddChannelDialog";
import { FONT_SIZE_PX, SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { HoverPreview } from "./components/HoverPreview";
import { subscribeToBackend, useChat } from "./store/chat";

export default function App() {
  const bootstrap = useChat((state) => state.bootstrap);

  const [showAdd, setShowAdd] = useState(false);
  // Which tab the settings dialog is open on, or null when it's closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const chatFontSize = useChat((state) => FONT_SIZE_PX[state.preferences.chatFontSize]);

  useEffect(() => {
    // Listeners first, then the reads: `subscribeToBackend` attaches over IPC
    // and so completes a turn or two later, and an event that lands in that
    // gap is simply lost -- several of them (live channels, owner avatars) are
    // sent only when something *changes*, so the next one could be minutes
    // away or never. Bootstrapping afterwards means anything missed is read
    // back rather than waited for.
    const listening = subscribeToBackend();
    void listening.then(() => bootstrap());
    return () => {
      void listening.then((off) => off());
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
        // The pane you were last in owns the shortcut -- closing the tab
        // you can see in the other one isn't what Ctrl+W means here.
        const { active, focusedPane, closeTab } = useChat.getState();
        const id = active[focusedPane];
        if (id) void closeTab(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A right-click selects the word under it by default -- the browser
  // preparing for a menu that isn't ours. `user-select: none` doesn't stop it,
  // so this does, on the way in: the selection is made on mousedown, before
  // the `contextmenu` event our own menus are opened from, which still fires.
  // A selection made by dragging is untouched, since preventing a default is
  // what stops one being made rather than what clears one.
  //
  // Window-wide rather than per-scroller: chat is not the only place with text
  // in it, and the title bar and tabs were selecting too.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      // Except in a field you can type in, where right-click is how you reach
      // Paste and needs to put the caret somewhere first.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    };
    window.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => window.removeEventListener("mousedown", onMouseDown, { capture: true });
  }, []);

  return (
    <div
      // Chat reads its text size off this; everything else is fixed.
      style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}
      className="flex h-full flex-col overflow-hidden bg-surface"
      onContextMenu={(event) => event.preventDefault()}
    >
      <TitleBar onOpenSettings={setSettingsTab} />
      <Panes onAdd={() => setShowAdd(true)} onSignIn={() => setSettingsTab("account")} />

      {showAdd && <AddChannelDialog onClose={() => setShowAdd(false)} />}
      {settingsTab && (
        <SettingsDialog
          tab={settingsTab}
          onChangeTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}
      <HoverPreview />
    </div>
  );
}
