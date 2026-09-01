import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { useChat } from "../store/chat";
import type { AuthStatus, DeviceCode } from "../types";

const CONSOLE_URL = "https://dev.twitch.tv/console/apps";

/**
 * The Client ID escape hatch.
 *
 * Every build ships with a working Client ID, so this is never part of signing
 * in -- it exists for the one case the built-in can't cover: the Twitch app
 * this release points at being suspended or rate-limited. Without it the only
 * way out would be waiting for a new release, so it stays reachable whether or
 * not you're signed in, but collapsed, since almost nobody should touch it.
 */
function ClientIdOverride({
  override,
  onChanged,
  onError,
}: {
  override: string | null;
  onChanged: (status: AuthStatus) => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(override ?? "");
  const [busy, setBusy] = useState(false);

  const apply = async (next: string) => {
    setBusy(true);
    onError(null);
    try {
      onChanged(await api.setClientIdOverride(next));
      setOpen(false);
    } catch (cause) {
      onError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="border-t border-line pt-3">
        {override ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
              Using a custom Client ID:{" "}
              <code className="selectable rounded bg-line px-1 text-ink-dim">{override}</code>
            </span>
            <button
              onClick={() => void apply("")}
              disabled={busy}
              className="shrink-0 text-[11px] text-ink-faint underline underline-offset-2 hover:text-ink-dim disabled:opacity-50"
            >
              Reset to built-in
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setValue("");
              setOpen(true);
            }}
            className="text-[11px] text-ink-faint hover:text-ink-dim"
          >
            Use a different Client ID
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Only needed if this build's Twitch app stops working. Register your own at{" "}
        <button
          onClick={() => void openUrl(CONSOLE_URL)}
          className="text-accent underline underline-offset-2"
        >
          dev.twitch.tv/console/apps
        </button>{" "}
        with <strong className="text-ink-dim">Client Type: Public</strong> and OAuth Redirect URL{" "}
        <code className="rounded bg-line px-1">http://localhost:3000</code>, then paste its Client
        ID here. This signs you out — a Twitch token only works with the app it was issued for.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) void apply(value);
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="Client ID"
          spellCheck={false}
          className="selectable min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-ink outline-none focus:border-accent"
        />
        <button
          onClick={() => void apply(value)}
          disabled={busy || !value.trim()}
          className="rounded-md bg-accent px-3 py-1.5 font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md border border-line px-3 py-1.5 text-ink transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Twitch sign-in: the device-code flow, signing out, and the Client ID escape
 * hatch. Lives in the settings dialog's Account tab, which is the only entry
 * point -- the title bar's account button opens the dialog on this tab.
 */
export function AccountPanel({ onDone }: { onDone: () => void }) {
  const auth = useChat((state) => state.auth);
  const setAuth = useChat((state) => state.setAuth);

  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const polling = useRef<number | null>(null);

  // Stop polling if the dialog closes mid-flow.
  useEffect(() => {
    return () => {
      if (polling.current) window.clearInterval(polling.current);
    };
  }, []);

  const startLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const code = await api.startDeviceAuth();
      setDevice(code);
      void openUrl(code.verification_uri);

      const deadline = Date.now() + code.expires_in * 1000;
      polling.current = window.setInterval(async () => {
        if (Date.now() > deadline) {
          window.clearInterval(polling.current!);
          setDevice(null);
          setError("The code expired. Try again.");
          return;
        }

        try {
          const result = await api.pollDeviceAuth(code.device_code);
          if (result.status === "granted") {
            window.clearInterval(polling.current!);
            setDevice(null);
            setAuth(await api.authStatus());
            onDone();
          } else if (result.status === "failed") {
            window.clearInterval(polling.current!);
            setDevice(null);
            setError(result.detail ?? "Authorization failed.");
          }
        } catch (cause) {
          window.clearInterval(polling.current!);
          setError(String(cause));
        }
      }, Math.max(code.interval, 1) * 1000);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setAuth(await api.logout());
  };

  const copyCode = async () => {
    if (!device) return;
    await navigator.clipboard.writeText(device.user_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4 text-[12px] leading-relaxed text-ink-dim">
      {auth.loggedIn ? (
        <>
          <p>
            Signed in as <span className="font-semibold text-ink">@{auth.login}</span>.
          </p>
          <button
            onClick={() => void signOut()}
            className="rounded-md border border-line px-3 py-1.5 text-ink transition-colors hover:bg-surface-hover"
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          {device ? (
            <div className="space-y-3">
              <p>Enter this code in the Twitch page that just opened:</p>
              <button
                onClick={() => void copyCode()}
                className="w-full rounded-lg border border-line bg-surface py-3 text-center font-mono text-[22px] tracking-[0.3em] text-ink transition-colors hover:border-accent"
              >
                {device.user_code}
              </button>
              <p className="text-center text-[11px] text-ink-faint">
                {copied ? "Copied." : "Click to copy. Waiting for approval..."}
              </p>
              <button
                onClick={() => void openUrl(device.verification_uri)}
                className="w-full rounded-md border border-line py-1.5 text-ink transition-colors hover:bg-surface-hover"
              >
                Reopen Twitch page
              </button>
            </div>
          ) : (
            <button
              onClick={() => void startLogin()}
              disabled={busy}
              className="w-full rounded-md bg-accent py-2 font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
            >
              Sign in with Twitch
            </button>
          )}
        </>
      )}

      {/* Deliberately outside both branches: if the shipped app breaks you may
          well be signed in when you find out, and this is the way back. */}
      {!device && (
        <ClientIdOverride
          override={auth.clientIdOverride}
          onChanged={setAuth}
          onError={setError}
        />
      )}

      {error && (
        <div className="rounded-md bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{error}</div>
      )}
    </div>
  );
}
