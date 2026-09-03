import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChat } from "../store/chat";
import { IS_MACOS, TITLE_BAR_PX } from "../lib/tauri";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import type { SettingsTab } from "./SettingsDialog";
import type { AuthStatus } from "../types";

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
      className={`mr-1 grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
        muted ? "text-rose-400/80 hover:text-rose-300" : "text-ink-dim hover:text-ink"
      }`}
    >
      <svg viewBox="0 0 16 16" width={GLYPH} height={GLYPH} fill="none" stroke="currentColor" strokeWidth="1.4">
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
 * Keep the window above the others. Beside the mute button for the same
 * reason: it's reached for while a stream is running, not while settings are
 * open. The appearance tab has the same switch.
 */
function PinButton() {
  const pinned = useChat((state) => state.preferences.alwaysOnTop);
  const toggleAlwaysOnTop = useChat((state) => state.toggleAlwaysOnTop);
  const label = pinned ? "Stop keeping on top" : "Keep on top";

  return (
    <button
      onClick={toggleAlwaysOnTop}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      className={`mr-1 grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
        pinned ? "text-accent" : "text-ink-dim hover:text-ink"
      }`}
    >
      {/* A drawing pin seen head-on: the disc, the shaft, and two shoulders.
          Filled when it's holding, outlined when it isn't, so the state reads
          from the weight of the mark rather than from colour alone. */}
      <svg
        viewBox="0 0 16 16"
        width={GLYPH}
        height={GLYPH}
        fill={pinned ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <path
          d="M6 1.8h4l-.5 3.4 2.2 2.3H4.3l2.2-2.3z"
          strokeLinejoin="round"
        />
        <path d="M8 7.5v6.7" strokeLinecap="round" fill="none" />
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
        className={`mr-1 grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
          layout === "none" ? "text-ink-dim hover:text-ink" : "text-accent hover:text-accent"
        }`}
      >
        {/* A pane with a divider through it, turned the way the window is
            actually divided -- upright while there's no split, since that's
            what picking one would give you. */}
        <svg viewBox="0 0 16 16" width={GLYPH} height={GLYPH} fill="none" stroke="currentColor" strokeWidth="1.3">
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

/**
 * The bar itself, which macOS shapes differently.
 *
 * Taller on macOS, so the traffic lights stop dominating it. They are a system
 * size and can't be scaled through any API Tauri exposes, so the only way to
 * make them look smaller is to give them more room.
 *
 * That costs the free vertical centring a 28px bar got: 28 is the standard
 * macOS title bar height, which is the height the lights are placed for, so
 * anything taller needs `trafficLightPosition` in tauri.macos.conf.json to put
 * them back in the middle. Everything else here centres itself, since the bar
 * is a flex row with `items-center`.
 *
 * The padding clears the lights, which end about 66px in. The gap after them
 * is the only part of this that's taste rather than arithmetic.
 */
const BAR = IS_MACOS ? "pl-[84px]" : "pl-3";

/** Everything else in the bar, sized to the bar it sits in. */
const ICON_BOX = IS_MACOS ? "h-8 w-8" : "h-6 w-6";
const GLYPH = IS_MACOS ? 16 : 13;
const TEXT = IS_MACOS ? "text-[12px]" : "text-[11px]";

export function TitleBar({ onOpenSettings }: { onOpenSettings: (tab: SettingsTab) => void }) {
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
      style={{ height: TITLE_BAR_PX }}
      className={`flex shrink-0 items-center border-b border-line bg-surface-raised ${BAR}`}
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span
          data-tauri-drag-region
          className={`shrink-0 font-semibold tracking-wide text-ink-dim ${TEXT}`}
        >
          ChatWow
        </span>
      </div>

      <div data-tauri-drag-region className="flex-1" />

      <button
        onClick={() => onOpenSettings("account")}
        className={`mr-1 shrink-0 whitespace-nowrap rounded px-2 py-1 text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink ${TEXT}`}
      >
        {accountLabel(auth)}
      </button>

      <PinButton />
      <MuteButton />
      <SplitButton />

      <button
        onClick={() => onOpenSettings("general")}
        aria-label={updatePending ? "Settings, an update is waiting" : "Settings"}
        title={updatePending ? "An update is waiting" : "Settings"}
        className={`relative mr-1 grid ${ICON_BOX} place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink`}
      >
        {/* A cog, not a sun: the teeth are a heavy dashed ring around the
            body circle, which reads as a gear at 13px without hand-plotting
            eight trapezoids. */}
        <svg viewBox="0 0 16 16" width={GLYPH} height={GLYPH} fill="none" stroke="currentColor">
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

      {!IS_MACOS && (
        <>
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
        </>
      )}
    </div>
  );
}
