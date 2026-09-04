import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { useChat } from "../store/chat";
import { Hinted } from "./Hinted";
import type { AccountInfo, AuthStatus, DeviceCode, PermissionGroup } from "../types";

const CONSOLE_URL = "https://dev.twitch.tv/console/apps";
const NEW_ACCOUNT_ID = "__new_account__";

/**
 * What the next sign-in asks Twitch for, and which accounts already hold it.
 *
 * Twitch grants scopes once, on the consent screen, and there's no way to
 * escalate later without going through the whole flow again -- so this is a
 * choice made *before* signing in, and changing it while signed in only takes
 * effect the next time you do. It's shared by every account (it's what to
 * *request*), while what was actually granted is per token: an account signed
 * in before you ticked a group simply doesn't have it. The selected account
 * makes that per-token state explicit.
 */
function Permissions({
  auth,
  account,
  newAccount,
  onChanged,
  onError,
  onGrant,
}: {
  auth: AuthStatus;
  account: AccountInfo | null;
  newAccount: boolean;
  onChanged: (status: AuthStatus) => void;
  onError: (message: string | null) => void;
  onGrant: (account: AccountInfo) => void;
}) {
  const [busy, setBusy] = useState(false);

  const isGranted = (group: PermissionGroup) =>
    account !== null && group.scopes.every((scope) => account.scopes.includes(scope));
  const isChecked = (group: PermissionGroup) =>
    group.required || auth.permissionGroups.includes(group.id);

  const toggle = async (group: PermissionGroup, on: boolean) => {
    const next = on
      ? [...auth.permissionGroups, group.id]
      : auth.permissionGroups.filter((id) => id !== group.id);

    setBusy(true);
    onError(null);
    try {
      onChanged(await api.setPermissionGroups(next));
    } catch (cause) {
      onError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  // This is deliberately about the selected account. The checked groups are
  // the template for the next sign-in, but the gap belongs to one token and
  // disappears as soon as that token comes back with every requested scope.
  const pending = auth.permissionCatalog.filter(
    (group) => account !== null && !group.required && isChecked(group) && !isGranted(group),
  );

  return (
    <Section
      title={account ? `Permissions for ${account.login}` : "Permissions for a new account"}
      note={
        account
          ? `Choose what Twitch asks for when you re-add ${account.login}.`
          : newAccount
            ? "Choose what Twitch asks for before signing in."
            : "Select an account above to inspect its permissions."
      }
    >
      <div className="space-y-1.5">
        {auth.permissionCatalog.map((group) => {
          return (
            <div key={group.id} className="flex items-center gap-2">
              <input
                id={`permission-${group.id}`}
                type="checkbox"
                checked={isChecked(group)}
                disabled={(account === null && !newAccount) || group.required || busy}
                onChange={(event) => void toggle(group, event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 accent-accent disabled:opacity-60"
              />
              {/* The label is outside the tooltip rather than inside it: the
                  tooltip trigger is focusable, so a click anywhere in it pins
                  the tooltip open, and this label's whole job is being clicked. */}
              <label
                htmlFor={`permission-${group.id}`}
                className={`text-[12px] text-ink ${group.required ? "" : "cursor-pointer"}`}
              >
                {group.label}
              </label>
              <Hinted hint={group.detail} />
              {/* Capability comes from the selected account's actual token,
                  never from the request checkbox beside it. */}
              <span className="ml-auto shrink-0 truncate text-[10px] text-ink-faint">
                {newAccount
                  ? isChecked(group)
                    ? "will request"
                    : "not requested"
                  : account === null
                    ? "select an account"
                    : isGranted(group)
                      ? "granted"
                      : "missing"}
              </span>
            </div>
          );
        })}
      </div>

      {pending.length > 0 && account !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-400/10 px-2 py-1.5">
          <span className="min-w-0 flex-1 text-[11px] text-amber-200/90">
            Re-add {account.login} to grant the newly enabled permissions. This reminder will
            disappear once the account has them.
          </span>
          <button
            onClick={() => onGrant(account)}
            className="shrink-0 rounded-md border border-amber-400/40 px-2 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-400/10"
          >
            Re-add {account.login}
          </button>
        </div>
      )}
    </Section>
  );
}

function NewAccountRow({
  isSelected,
  busy,
  onSelect,
  onSignIn,
}: {
  isSelected: boolean;
  busy: boolean;
  onSelect: () => void;
  onSignIn: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 transition-colors ${
        isSelected
          ? "border-accent/60 bg-accent/5"
          : "border-line bg-surface hover:border-accent/30 hover:bg-surface-hover"
      }`}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-lg text-accent">
        +
      </span>
      <div className="min-w-0 flex-1 basis-28">
        <div className="text-[13px] text-ink">Add account</div>
        <div className="text-[11px] text-ink-faint">Choose permissions below, then sign in.</div>
      </div>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onSignIn();
        }}
        disabled={busy}
        className="ml-auto shrink-0 rounded-md bg-accent px-3 py-1 font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-50"
      >
        Sign in
      </button>
    </div>
  );
}

/** A titled block in the panel, so the three parts read as three things. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {title}
        </h3>
        {note && <p className="mt-0.5 text-[11px] text-ink-faint">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * One signed-in account: who it is, what it's being used for, and the two
 * things you can do to it, including choosing it for the permission editor.
 *
 * The tab count is the useful fact about an account here -- signing one out
 * doesn't close its tabs (they fall back to anonymous), so knowing how many
 * are about to lose their composer is what the number is for.
 */
function AccountRow({
  account,
  isDefault,
  isSelected,
  tabs,
  onSelect,
  onMakeDefault,
  onSignOut,
}: {
  account: AccountInfo;
  isDefault: boolean;
  isSelected: boolean;
  tabs: number;
  onSelect: () => void;
  onMakeDefault: () => void;
  onSignOut: () => void;
}) {
  return (
    // Wraps rather than squeezing: the two buttons don't shrink, and below
    // about 400px they'd otherwise leave the login no width at all and push
    // the tab count out around them. They drop onto their own line instead.
    <div
      onClick={onSelect}
      className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 transition-colors ${
        isSelected
          ? "border-accent/60 bg-accent/5"
          : "border-line bg-surface hover:border-accent/30 hover:bg-surface-hover"
      }`}
    >
      {/* The account's own profile picture, which is the fastest way to tell
          two logins apart. It rides on the auth status rather than being
          fetched here, so a row draws with a face immediately -- and an account
          Twitch has no picture for (or hasn't been asked about yet, which is
          every account signed in before this shipped) falls back to its
          initial rather than to an empty circle. */}
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt=""
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-[13px] font-semibold uppercase text-accent">
          {account.login.slice(0, 1)}
        </span>
      )}

      <div className="min-w-0 flex-1 basis-28">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-ink">{account.login}</span>
          {isDefault && (
            <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-semibold text-accent">
              default
            </span>
          )}
        </div>
        <span className="text-[11px] text-ink-faint">
          {tabs === 0 ? "No tabs" : tabs === 1 ? "1 tab" : `${tabs} tabs`}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!isDefault && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onMakeDefault();
            }}
            title="New tabs will use this account"
            className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Use for new tabs
          </button>
        )}
        <button
          onClick={(event) => {
            event.stopPropagation();
            onSignOut();
          }}
          title="Sign out. Its tabs stay open and keep reading."
          className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

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
 * The accounts manager: who's signed in, which of them new tabs use, adding
 * another, selecting one for permission changes, and the Client ID escape
 * hatch.
 *
 * Accounts are a list rather than a state, because a tab picks one -- so this
 * screen is about the list, and signing in is one row's worth of it rather
 * than the whole page.
 */
export function AccountPanel({ onDone }: { onDone: () => void }) {
  const auth = useChat((state) => state.auth);
  const setAuth = useChat((state) => state.setAuth);
  const tabs = useChat((state) => state.tabs);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const polling = useRef<number | null>(null);
  const pollingSession = useRef(0);

  const stopPolling = () => {
    pollingSession.current += 1;
    if (polling.current !== null) window.clearTimeout(polling.current);
    polling.current = null;
  };

  // Stop polling if the dialog closes mid-flow.
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  // Keep the permission editor on the same account across token replacement.
  // The new-account card is also a stable selection while its request changes.
  // If an existing selection is removed, select the default, first remaining,
  // or new-account card in that order.
  useEffect(() => {
    setSelectedAccountId((current) => {
      if (current === NEW_ACCOUNT_ID) return current;
      if (current && auth.accounts.some((account) => account.id === current)) return current;
      return (
        auth.accounts.find((account) => account.id === auth.defaultAccount)?.id ??
        auth.accounts[0]?.id ??
        NEW_ACCOUNT_ID
      );
    });
  }, [auth.accounts, auth.defaultAccount]);

  const selectedAccount =
    auth.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const newAccountSelected = selectedAccountId === NEW_ACCOUNT_ID;

  const startLogin = async (expectedAccount?: AccountInfo) => {
    setBusy(true);
    setError(null);
    try {
      const code = await api.startDeviceAuth();
      setDevice(code);
      void openUrl(code.verification_uri);

      const deadline = Date.now() + code.expires_in * 1000;
      const session = ++pollingSession.current;
      const interval = Math.max(code.interval, 1) * 1000;
      const poll = async () => {
        if (pollingSession.current !== session) return;
        if (Date.now() > deadline) {
          stopPolling();
          setDevice(null);
          setError("The code expired. Try again.");
          return;
        }

        try {
          const result = await api.pollDeviceAuth(code.device_code);
          if (pollingSession.current !== session) return;
          if (result.status === "granted") {
            stopPolling();
            setDevice(null);
            const next = await api.authStatus();
            setAuth(next);
            const signedInLogin = result.login?.toLocaleLowerCase();
            const signedIn = signedInLogin
              ? next.accounts.find(
                  (account) => account.login.toLocaleLowerCase() === signedInLogin,
                )
              : undefined;
            if (!expectedAccount && signedIn) setSelectedAccountId(signedIn.id);
            if (
              expectedAccount &&
              result.login &&
              result.login.toLocaleLowerCase() !== expectedAccount.login.toLocaleLowerCase()
            ) {
              setError(
                `Signed in as ${result.login}. Re-add ${expectedAccount.login} to update that account's permissions.`,
              );
            }
            // Adding a second account is usually a step towards something
            // else in here, so only the first one closes the dialog.
            if (auth.accounts.length === 0) onDone();
          } else if (result.status === "failed") {
            stopPolling();
            setDevice(null);
            setError(result.detail ?? "Authorization failed.");
          } else {
            polling.current = window.setTimeout(() => void poll(), interval);
          }
        } catch (cause) {
          stopPolling();
          setDevice(null);
          setError(String(cause));
        }
      };
      polling.current = window.setTimeout(() => void poll(), interval);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!device) return;
    await navigator.clipboard.writeText(device.user_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const tabsUsing = (id: string) => tabs.filter((tab) => tab.account === id).length;

  return (
    <div className="space-y-5 text-[12px] leading-relaxed text-ink-dim">
      {/* The sign-in code takes over the panel while it's live: it's a thing
          to go and do, on a Twitch page, and everything else can wait. */}
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
          <div className="flex gap-2">
            <button
              onClick={() => void openUrl(device.verification_uri)}
              className="flex-1 rounded-md border border-line py-1.5 text-ink transition-colors hover:bg-surface-hover"
            >
              Reopen Twitch page
            </button>
            <button
              onClick={() => {
                stopPolling();
                setDevice(null);
              }}
              className="rounded-md border border-line px-3 py-1.5 text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-ink-faint">
            Signing in as somebody else adds that account rather than replacing this one. Use
            a private window if Twitch keeps signing you in as the same person.
          </p>
        </div>
      ) : (
        <>
          <Section
            title="Accounts"
            note={
              auth.accounts.length > 1
                ? "Each tab reads and sends as one of these. Right-click a tab to change it."
                : "Sign in to send messages. You can add more than one and give each tab its own."
            }
          >
            <div className="space-y-1.5">
              {auth.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  isDefault={account.id === auth.defaultAccount}
                  isSelected={account.id === selectedAccountId}
                  tabs={tabsUsing(account.id)}
                  onSelect={() => setSelectedAccountId(account.id)}
                  onMakeDefault={async () => setAuth(await api.setDefaultAccount(account.id))}
                  onSignOut={async () => setAuth(await api.removeAccount(account.id))}
                />
              ))}

              <NewAccountRow
                isSelected={newAccountSelected}
                busy={busy}
                onSelect={() => setSelectedAccountId(NEW_ACCOUNT_ID)}
                onSignIn={() => {
                  setSelectedAccountId(NEW_ACCOUNT_ID);
                  void startLogin();
                }}
              />
            </div>
          </Section>

          {/* The request template is app-wide, while the granted state shown
              here belongs to the selected account's token. */}
          <Permissions
            auth={auth}
            account={selectedAccount}
            newAccount={newAccountSelected}
            onChanged={setAuth}
            onError={setError}
            onGrant={(account) => void startLogin(account)}
          />

          <ClientIdOverride
            override={auth.clientIdOverride}
            onChanged={setAuth}
            onError={setError}
          />
        </>
      )}

      {error && (
        <div className="rounded-md bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">{error}</div>
      )}
    </div>
  );
}
