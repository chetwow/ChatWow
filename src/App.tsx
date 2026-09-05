import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { TitleBar } from "./components/TitleBar";
import { Panes, type TabSearchSession } from "./components/Panes";
import { AddChannelDialog } from "./components/AddChannelDialog";
import { FONT_SIZE_PX, SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { HoverPreview } from "./components/HoverPreview";
import { ListenerCloseDialog } from "./components/ListenerCloseDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import {
  acknowledgeReleaseNotes,
  unseenReleaseNotes,
} from "./lib/whatsNew";
import type { ReleaseNotes } from "./lib/releaseNotes";
import { themeStyle } from "./lib/themes";
import { subscribeToBackend, useChat } from "./store/chat";

export default function App() {
  const bootstrap = useChat((state) => state.bootstrap);

  const [showAdd, setShowAdd] = useState(false);
  // Which tab the settings dialog is open on, or null when it's closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [search, setSearch] = useState<TabSearchSession | null>(null);
  const [whatsNew, setWhatsNew] = useState<ReleaseNotes | null>(null);
  const chatFontSize = useChat((state) => FONT_SIZE_PX[state.preferences.chatFontSize]);
  const gifScale = useChat((state) => state.preferences.gifScale);
  const theme = useChat((state) => state.preferences.theme);
  const focusedTab = useChat((state) => state.active[state.focusedPane]);

  const openSearch = useCallback(() => {
    const { active, focusedPane } = useChat.getState();
    const tabId = active[focusedPane];
    if (!tabId) return;
    // Bumping the request refocuses and selects the existing query when the
    // same button or shortcut is used a second time.
    setSearch((current) => ({ tabId, request: (current?.request ?? 0) + 1 }));
  }, []);

  const toggleSearch = useCallback(() => {
    const { active, focusedPane } = useChat.getState();
    const tabId = active[focusedPane];
    if (!tabId) return;
    setSearch((current) =>
      current?.tabId === tabId
        ? null
        : { tabId, request: (current?.request ?? 0) + 1 },
    );
  }, []);

  // Search belongs to the tab in the pane being worked in. Moving that focus
  // or switching its active tab closes the old find bar rather than leaving a
  // hidden search session attached to something no longer active.
  useEffect(() => {
    setSearch((current) => (current && current.tabId !== focusedTab ? null : current));
  }, [focusedTab]);

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

  useEffect(() => {
    let active = true;
    void unseenReleaseNotes()
      .then((notes) => {
        if (active) setWhatsNew(notes);
      })
      .catch((error) => console.warn("Couldn't load What's New state", error));
    return () => {
      active = false;
    };
  }, []);

  const closeWhatsNew = useCallback(() => {
    setWhatsNew(null);
    void acknowledgeReleaseNotes().catch((error) =>
      console.warn("Couldn't save What's New state", error),
    );
  }, []);

  // Ctrl+K opens the channel switcher, matching the command-palette
  // convention. Ctrl/Cmd+F searches the active tab. Ctrl/Cmd+T and Ctrl/Cmd+W
  // are the browser's new-tab and close-tab, which is what a row of tabs sets people up to expect --
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
      if (key === "f") {
        event.preventDefault();
        if (!document.querySelector("[data-modal]")) openSearch();
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
        const { active, focusedPane, requestCloseTab } = useChat.getState();
        const id = active[focusedPane];
        if (id) requestCloseTab(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // A right-click selects the word under it, which is the webview preparing
  // for a menu that isn't ours -- and it means a right-click arrives carrying a
  // word nobody chose, which Copy would then offer as "the selection".
  //
  // Three defences, because one isn't portable. Chromium (Windows, Linux)
  // honours the prevented default on mousedown. WebKit makes the selection in
  // its own layer as part of opening its menu, where no DOM default is
  // consulted at all, so there it's taken back afterwards instead -- and on a
  // later tick as well as immediately, since it can be made after `contextmenu`
  // has already fired.
  //
  // Only ever a selection this right-click created: one made by dragging is
  // still there when the button goes down, and right-clicking inside it to copy
  // it has to keep working.
  useEffect(() => {
    let fromRightClick = false;
    let hadSelection = false;

    const editable = (target: EventTarget | null) =>
      !!(target as HTMLElement | null)?.closest("input, textarea, [contenteditable='true']");

    const clearIfOurs = () => {
      if (!hadSelection) window.getSelection()?.removeAllRanges();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      // Except in a field you can type in, where right-click is how you reach
      // Paste and needs to put the caret somewhere first.
      if (editable(event.target)) return;
      fromRightClick = true;
      hadSelection = !!window.getSelection()?.toString();
      event.preventDefault();
    };

    const onSelectStart = (event: Event) => {
      if (fromRightClick && !editable(event.target)) event.preventDefault();
    };

    // Capture, so this runs before the menus that read the selection to decide
    // what Copy should offer.
    const onContextMenu = () => {
      if (!fromRightClick) return;
      clearIfOurs();
      setTimeout(clearIfOurs, 0);
      fromRightClick = false;
    };

    const onMouseUp = () => {
      fromRightClick = false;
    };

    const options = { capture: true } as const;
    window.addEventListener("mousedown", onMouseDown, options);
    window.addEventListener("selectstart", onSelectStart, options);
    window.addEventListener("contextmenu", onContextMenu, options);
    window.addEventListener("mouseup", onMouseUp, options);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, options);
      window.removeEventListener("selectstart", onSelectStart, options);
      window.removeEventListener("contextmenu", onContextMenu, options);
      window.removeEventListener("mouseup", onMouseUp, options);
    };
  }, []);

  return (
    <div
      // Appearance preferences resolve to CSS properties here so every part
      // of the window, including dialogs and fixed previews, inherits them.
      data-theme={theme}
      style={
        {
          ...themeStyle(theme),
          "--chat-font-size": `${chatFontSize}px`,
          "--gif-scale": gifScale,
        } as CSSProperties
      }
      className="flex h-full flex-col overflow-hidden bg-surface"
      onContextMenu={(event) => event.preventDefault()}
    >
      <TitleBar
        onOpenSettings={setSettingsTab}
        onSearch={toggleSearch}
        searchActive={search?.tabId === focusedTab}
      />
      <Panes
        onAdd={() => setShowAdd(true)}
        onSignIn={() => setSettingsTab("account")}
        search={search}
        onCloseSearch={() => setSearch(null)}
      />

      {showAdd && <AddChannelDialog onClose={() => setShowAdd(false)} />}
      {settingsTab && (
        <SettingsDialog
          tab={settingsTab}
          onChangeTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}
      <ListenerCloseDialog />
      {whatsNew && <WhatsNewDialog notes={whatsNew} onClose={closeWhatsNew} />}
      <HoverPreview />
    </div>
  );
}
