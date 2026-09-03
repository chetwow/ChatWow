import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { connectionState, useChat } from "../store/chat";
import { IS_TAURI } from "../lib/tauri";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import type { SettingsTab } from "./SettingsDialog";
import type { AuthStatus } from "../types";

const DOT: Record<string, string> = {
  connected: "bg-emerald-400",
  connecting: "bg-amber-400",
  reconnecting: "bg-amber-400",
  disconnected: "bg-rose-500",
};

function ControlButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      // Full bar height, so the hover fill reads as part of the title bar --
      // it's the width that carries the padding around the 10px glyph.
      className={`grid h-8 w-9 place-items-center text-ink-dim transition-colors hover:text-ink ${
        danger ? "hover:bg-rose-600 hover:text-white" : "hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Mute for the mention ping. Lives in the title bar rather than behind a
 * dialog because it's the one thing you reach for mid-stream; it moves into
 * the settings screen once there is one.
 */
function MuteButton() {
  const muted = useChat((state) => state.preferences.muted);
  const toggleMuted = useChat((state) => state.toggleMuted);
  const label = muted ? "Unmute mention ping" : "Mute mention ping";

  return (
    <button
      onClick={toggleMuted}
      aria-label={label}
      aria-pressed={muted}
      title={label}
      className={`mr-1 grid h-6 w-6 place-items-center rounded transition-colors hover:bg-surface-hover ${
        muted ? "text-rose-400/80 hover:text-rose-300" : "text-ink-dim hover:text-ink"
      }`}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M8.5 3 5 6H2.5v4H5l3.5 3z" strokeLinejoin="round" />
        {muted ? (
          <path d="M11 6.5l3.5 3.5M14.5 6.5L11 10" strokeLinecap="round" />
        ) : (
          <>
            <path d="M11.2 5.8a3.5 3.5 0 0 1 0 4.4" strokeLinecap="round" />
            <path d="M13.2 4.2a6 6 0 0 1 0 7.6" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}

/**
 * Divide the window, or put it back. The four directions say where the new
 * pane goes, which is only a question while there isn't one -- once the
 * window is split there are two panes to arrange rather than one to add, so
 * the menu turns into the three things you can do with them.
 */
function SplitButton() {
  const layout = useChat((state) => state.preferences.splitLayout);
  const split = useChat((state) => state.split);
  const setSplitLayout = useChat((state) => state.setSplitLayout);
  const swapPanes = useChat((state) => state.swapPanes);
  const removeSplit = useChat((state) => state.removeSplit);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const options: ContextMenuOption[] =
    layout === "none"
      ? [
          { label: "Split left", onSelect: () => split("row", true) },
          { label: "Split right", onSelect: () => split("row", false) },
          { label: "Split up", onSelect: () => split("column", true) },
          { label: "Split down", onSelect: () => split("column", false) },
        ]
      : [
          { label: "Side by side", onSelect: () => setSplitLayout("row") },
          { label: "Stacked", onSelect: () => setSplitLayout("column") },
          { label: "Swap panes", onSelect: swapPanes },
          { separator: true },
          { label: "Remove split", onSelect: removeSplit },
        ];

  return (
    <>
      <button
        ref={button}
        onClick={() => {
          // Opened under the button rather than at the pointer: it's a menu
          // belonging to a control, not a context menu for what was clicked.
          const box = button.current?.getBoundingClientRect();
          setMenu(menu ? null : { x: box ? box.left : 0, y: box ? box.bottom + 4 : 0 });
        }}
        aria-label="Split view"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title="Split view"
        className={`mr-1 grid h-6 w-6 place-items-center rounded transition-colors hover:bg-surface-hover ${
          layout === "none" ? "text-ink-dim hover:text-ink" : "text-accent hover:text-accent"
        }`}
      >
        {/* A pane with a divider through it, turned the way the window is
            actually divided -- upright while there's no split, since that's
            what picking one would give you. */}
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" />
          {layout === "column" ? <path d="M1.7 8h12.6" /> : <path d="M8 2.7v10.6" />}
        </svg>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          options={options}
          closeOnScroll={false}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/**
 * What the account button says. One account is named; several are counted,
 * since no single one of them is "the" account any more and the list is a
 * click away.
 */
function accountLabel(auth: AuthStatus): string {
  if (auth.accounts.length === 0) return "Sign in";
  if (auth.accounts.length === 1) return `@${auth.accounts[0].login}`;
  return `${auth.accounts.length} accounts`;
}

export function TitleBar({ onOpenSettings }: { onOpenSettings: (tab: SettingsTab) => void }) {
  // One socket per account, so the dot shows the worst of them.
  const connection = useChat(connectionState);
  const auth = useChat((state) => state.auth);
  // A newer release, being fetched, or waiting to be restarted into -- all
  // three are "there is something to do in settings", which is all the dot
  // says. It stays until acted on, which a chat notice wouldn't.
  const updatePending = useChat(
    (state) =>
      state.update.stage === "available" ||
      state.update.stage === "downloading" ||
      state.update.stage === "ready",
  );

  return (
    <div
      data-tauri-drag-region
      className="flex h-8 shrink-0 items-center border-b border-line bg-surface-raised pl-3"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[connection] ?? "bg-ink-faint"}`} />
        <span
          data-tauri-drag-region
          className="text-[11px] font-semibold tracking-wide text-ink-dim"
        >
          ChatWow
        </span>
        {!IS_TAURI && (
          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-amber-400">
            PREVIEW · MOCK DATA
          </span>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1" />

      <MuteButton />
      <SplitButton />

      <button
        onClick={() => onOpenSettings("general")}
        aria-label={updatePending ? "Settings, an update is waiting" : "Settings"}
        title={updatePending ? "An update is waiting" : "Settings"}
        className="relative mr-1 grid h-6 w-6 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {/* A cog, not a sun: the teeth are a heavy dashed ring around the
            body circle, which reads as a gear at 13px without hand-plotting
            eight trapezoids. */}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
          <circle cx="8" cy="8" r="5.15" strokeWidth="2.1" strokeDasharray="2.15 2.25" />
          <circle cx="8" cy="8" r="4.15" strokeWidth="1.3" />
          <circle cx="8" cy="8" r="1.75" strokeWidth="1.3" />
        </svg>
        {/* Absolutely positioned inside the button's own fixed 6x6 box: the
            dot must never change what the row measures, the way the tab bar's
            hover affordances mustn't. */}
        {updatePending && (
          <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-accent" />
        )}
      </button>

      <button
        onClick={() => onOpenSettings("account")}
        className="mr-1 rounded px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {accountLabel(auth)}
      </button>

      <ControlButton onClick={() => void getCurrentWindow().minimize()} label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </ControlButton>
      <ControlButton onClick={() => void getCurrentWindow().toggleMaximize()} label="Maximize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
      </ControlButton>
      <ControlButton onClick={() => void getCurrentWindow().close()} label="Close" danger>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
        </svg>
      </ControlButton>
    </div>
  );
}
