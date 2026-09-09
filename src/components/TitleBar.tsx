import { IS_MAIN_WINDOW } from "../lib/windows";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { panes, useChat } from "../store/chat";
import { adjacentPane } from "../lib/panes";
import { useSplitTarget } from "../store/splitTarget";
import { api } from "../lib/api";
import { IS_MACOS, IS_TAURI, TITLE_BAR_PX } from "../lib/tauri";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import type { SettingsTab } from "./SettingsDialog";
import type { AuthStatus, SplitDirection } from "../types";

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
      className={`${ICON_GAP} grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
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
      className={`${ICON_GAP} grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
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

/** Choose a panel independently of chat focus, then split it in any direction. */
function SplitButton() {
  const split = useChat((state) => state.split);
  const removePane = useChat((state) => state.removePane);
  const count = useChat((state) => panes(state).length);
  const target = useSplitTarget((state) => state.pane);
  const select = useSplitTarget((state) => state.select);
  const button = useRef<HTMLButtonElement>(null);
  const cursorFrame = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const cancelCursorRestore = () => {
    if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    cursorFrame.current = null;
  };
  useEffect(() => () => {
    select(null);
    cancelCursorRestore();
  }, [select]);

  const close = () => {
    cancelCursorRestore();
    setMenu(null);
    select(null);
  };
  const navigate = (event: KeyboardEvent) => {
    const directions: Record<string, SplitDirection> = {
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    };
    const direction = directions[event.key];
    if (!direction || target === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rects = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).map((element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { id: Number(element.dataset.paneId), left, top, right, bottom };
    });
    select(adjacentPane(rects, target, direction));
    if (IS_TAURI && IS_MACOS) {
      // WebKit hides the pointer after handling keydown, even when JS cancels
      // it. Restore it after that event has finished, without moving the mouse.
      cancelCursorRestore();
      cursorFrame.current = requestAnimationFrame(() => {
        cursorFrame.current = null;
        void api.showMenuCursor().catch((error) => console.warn("Couldn't restore menu cursor", error));
      });
    }
  };
  const options: ContextMenuOption[] = [
    ...(["left", "right", "up", "down"] as const).map((direction) => ({
      label: `Split ${direction}`,
      onSelect: () => { if (target !== null) split(target, direction); },
    })),
    ...(count > 1 ? [
      { separator: true } as const,
      { label: "Remove panel", onSelect: () => { if (target !== null) removePane(target); } },
    ] : []),
  ];

  return (
    <>
      <button
        ref={button}
        onClick={() => {
          const box = button.current?.getBoundingClientRect();
          select(useChat.getState().focusedPane);
          setMenu({ x: box?.left ?? 0, y: box ? box.bottom + 4 : 0 });
        }}
        aria-label="Split view"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title="Split view"
        className={`${ICON_GAP} grid ${ICON_BOX} place-items-center rounded transition-colors hover:bg-surface-hover ${
          menu ? "text-accent" : "text-ink-dim hover:text-ink"
        }`}
      >
        <svg viewBox="0 0 16 16" width={GLYPH} height={GLYPH} fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.6" />
          <path d="M8 2.7v10.6" />
        </svg>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} options={options} onClose={close}
        onKeyDown={navigate} autoFocus label="Split panel" />}
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
const BAR = IS_MACOS ? "pl-[84px] pr-1" : "pl-3";

/** Everything else in the bar, sized to the bar it sits in. */
// The box is the hover target, not the icon. Squeezing it tightens the row
// without shrinking anything you can see, so the glyphs stay at 16.
const ICON_BOX = IS_MACOS ? "h-7 w-7" : "h-6 w-6";
const ICON_GAP = IS_MACOS ? "" : "mr-1";
const GLYPH = IS_MACOS ? 16 : 13;
const TEXT = IS_MACOS ? "text-[12px]" : "text-[11px]";

function AppInfoButton() {
  const version = useChat((state) => state.update.currentVersion);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("blur", dismiss);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}>
      <button ref={button}
        onPointerDown={(event) => {
          // WebKit can blur the panel without focusing a clicked button.
          // Keep focus until click toggles it, so blur cannot close then reopen it.
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => setOpen((current) => !current)}
        aria-label="About ChatWow" title="About ChatWow"
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "app-info" : undefined}
        className={`grid ${ICON_BOX} place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink`}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width={GLYPH} height={GLYPH}
          fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7v4" strokeLinecap="round" />
          <circle cx="8" cy="4.7" r=".8" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div ref={panel} id="app-info" role="dialog" aria-labelledby="app-info-name"
          data-modal tabIndex={-1}
          className="absolute right-0 top-full z-50 mt-1 w-56 max-w-[calc(100vw-100px)] rounded-lg border border-line bg-surface-raised p-4 shadow-2xl shadow-black/60 outline-none">
          <h2 id="app-info-name" className="text-[14px] font-semibold text-ink">ChatWow</h2>
          <p className="mt-1 text-[12px] text-ink-dim">{version ? `Version ${version}` : "Loading version…"}</p>
          {/* Ordinary external link: deliberately no chat-link hover preview. */}
          <a href="https://github.com/chetwow/ChatWow" target="_blank" rel="noopener noreferrer"
            onClick={(event) => {
              if (IS_TAURI) {
                event.preventDefault();
                void openUrl("https://github.com/chetwow/ChatWow");
              }
            }}
            className="mt-3 inline-block text-[12px] text-accent hover:underline focus-visible:outline-accent">
            GitHub
          </a>
        </div>
      )}
    </div>
  );
}

export function TitleBar({
  onOpenSettings,
  onSearch,
  searchActive,
}: {
  onOpenSettings: (tab: SettingsTab) => void;
  onSearch: () => void;
  searchActive: boolean;
}) {
  const auth = useChat((state) => state.auth);
  const hasActiveTab = useChat((state) => state.active[state.focusedPane] !== null);
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
      <div data-tauri-drag-region className="flex-1" />

      {IS_MAIN_WINDOW && <button
        onClick={() => onOpenSettings("account")}
        className={`mr-1 shrink-0 whitespace-nowrap rounded px-2 py-1 text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink ${TEXT}`}
      >
        {accountLabel(auth)}
      </button>}

      <button
        onClick={onSearch}
        disabled={!hasActiveTab}
        aria-label="Search active tab"
        aria-pressed={searchActive}
        title={`Search active tab (${IS_MACOS ? "⌘F" : "Ctrl+F"})`}
        className={`${ICON_GAP} grid ${ICON_BOX} place-items-center rounded transition-colors disabled:opacity-35 ${
          searchActive
            ? "bg-surface-hover text-accent"
            : "text-ink-dim hover:bg-surface-hover hover:text-ink"
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          width={GLYPH}
          height={GLYPH}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <circle cx="6.8" cy="6.8" r="4.2" />
          <path d="m10 10 3.5 3.5" strokeLinecap="round" />
        </svg>
      </button>

      <PinButton />
      <MuteButton />
      <SplitButton />

      {IS_MAIN_WINDOW && <button
        onClick={() => onOpenSettings("general")}
        aria-label={updatePending ? "Settings, an update is waiting" : "Settings"}
        title={updatePending ? "An update is waiting" : "Settings"}
        className={`relative ml-3 ${ICON_GAP} grid ${ICON_BOX} place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink`}
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
      </button>}

      {IS_MAIN_WINDOW && <AppInfoButton />}

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
