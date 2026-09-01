import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChat } from "../store/chat";
import { IS_TAURI } from "../lib/tauri";
import type { SettingsTab } from "./SettingsDialog";

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
      className={`grid h-8 w-11 place-items-center text-ink-dim transition-colors hover:text-ink ${
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

export function TitleBar({ onOpenSettings }: { onOpenSettings: (tab: SettingsTab) => void }) {
  const connection = useChat((state) => state.connection);
  const auth = useChat((state) => state.auth);

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

      <button
        onClick={() => onOpenSettings("appearance")}
        aria-label="Settings"
        title="Settings"
        className="mr-1 grid h-6 w-6 place-items-center rounded text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {/* A cog, not a sun: the teeth are a heavy dashed ring around the
            body circle, which reads as a gear at 13px without hand-plotting
            eight trapezoids. */}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
          <circle cx="8" cy="8" r="5.15" strokeWidth="2.1" strokeDasharray="2.15 2.25" />
          <circle cx="8" cy="8" r="4.15" strokeWidth="1.3" />
          <circle cx="8" cy="8" r="1.75" strokeWidth="1.3" />
        </svg>
      </button>

      <button
        onClick={() => onOpenSettings("account")}
        className="mr-1 rounded px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
      >
        {auth.loggedIn ? `@${auth.login}` : "Sign in"}
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
