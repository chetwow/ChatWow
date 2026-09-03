import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AccountInfo, MentionFilter } from "../types";
import { useChat } from "../store/chat";
import {
  findChatters,
  mergeChatters,
  type ChatterMatch,
} from "../lib/chatterComplete";
import { ChatterPicker } from "./ChatterPicker";

function Choice({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        selected
          ? "border-accent/50 bg-accent/20 text-accent"
          : "border-line text-ink-dim hover:bg-surface-hover hover:text-ink"
      }`}
    >
      {selected ? "✓ " : ""}
      {label}
    </button>
  );
}

/** Shared fields and validation for creating or editing a mentions listener. */
export function MentionFilterEditor({
  initial,
  accounts,
  channels,
  submitLabel,
  busyLabel,
  autoFocusName = false,
  onSave,
  onCancel,
}: {
  initial: MentionFilter;
  accounts: AccountInfo[];
  channels: string[];
  submitLabel: string;
  busyLabel: string;
  autoFocusName?: boolean;
  onSave: (mention: MentionFilter) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [selectedAccounts, setSelectedAccounts] = useState([...initial.accounts]);
  const [users, setUsers] = useState([...(initial.users ?? [])]);
  const [user, setUser] = useState("");
  const [userFocused, setUserFocused] = useState(false);
  const [userSelected, setUserSelected] = useState(0);
  const [userDismissedFor, setUserDismissedFor] = useState<string | null>(null);
  const [selectedChannels, setSelectedChannels] = useState([...initial.channels]);
  const [phrases, setPhrases] = useState([...initial.phrases]);
  const [phrase, setPhrase] = useState("");
  const [notify, setNotify] = useState(initial.notify ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const userInput = useRef<HTMLInputElement>(null);
  const tabs = useChat((state) => state.tabs);
  const chatterMaps = useChat((state) => state.chatters);

  useEffect(() => {
    if (autoFocusName) nameInput.current?.select();
  }, [autoFocusName]);

  const toggle = (items: string[], item: string, selected: boolean) =>
    selected ? items.filter((value) => value !== item) : [...items, item];

  const normalizeUser = (value: string) =>
    value.trim().replace(/^@/, "").toLocaleLowerCase();
  const validUser = (value: string) => /^[a-z0-9_]{1,25}$/i.test(value);

  // Suggestions come only from the selected source channels, merging copies
  // seen through different account tabs into one session-local inventory.
  const availableChatters = useMemo(
    () =>
      mergeChatters(
        tabs
          .filter(
            (tab) => tab.kind === "channel" && selectedChannels.includes(tab.channel),
          )
          .map((tab) => chatterMaps[tab.id]),
      ),
    [tabs, chatterMaps, selectedChannels],
  );
  const userMatches = useMemo(
    () =>
      user.trim()
        ? findChatters(availableChatters, normalizeUser(user))
            .filter(({ login }) => !users.includes(login))
            .slice(0, 50)
        : [],
    [availableChatters, user, users],
  );
  const userPickerOpen =
    userFocused && userDismissedFor !== user && userMatches.length > 0;
  const userHighlighted = Math.min(userSelected, userMatches.length - 1);

  const pickUser = (chatter: ChatterMatch) => {
    if (!users.includes(chatter.login)) setUsers((held) => [...held, chatter.login]);
    setUser("");
    setUserSelected(0);
    setUserDismissedFor(null);
    setError(null);
    userInput.current?.focus();
  };

  const addUser = () => {
    const next = normalizeUser(user);
    if (!next) return;
    if (!validUser(next)) return setError("Enter a valid Twitch username.");
    if (!users.includes(next)) setUsers((held) => [...held, next]);
    setUser("");
    setError(null);
  };

  const addPhrase = () => {
    const next = phrase.trim();
    if (!next) return;
    if (!phrases.some((held) => held.toLocaleLowerCase() === next.toLocaleLowerCase())) {
      setPhrases((held) => [...held, next]);
    }
    setPhrase("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    const draft = phrase.trim();
    const allPhrases =
      draft && !phrases.some((held) => held.toLocaleLowerCase() === draft.toLocaleLowerCase())
        ? [...phrases, draft]
        : phrases;
    const draftUser = normalizeUser(user);
    if (draftUser && !validUser(draftUser)) {
      return setError("Enter a valid Twitch username.");
    }
    const allUsers = draftUser && !users.includes(draftUser) ? [...users, draftUser] : users;
    const cleanName = name.trim();
    if (!cleanName) return setError("Give the tab a name.");
    if (selectedChannels.length === 0) return setError("Choose at least one channel.");
    if (selectedAccounts.length === 0 && allUsers.length === 0 && allPhrases.length === 0) {
      return setError("Choose an account, user, or phrase to listen for.");
    }

    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: cleanName,
        accounts: selectedAccounts,
        users: allUsers,
        channels: selectedChannels,
        phrases: allPhrases,
        notify,
      });
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-faint">Tab name</span>
          <input
            ref={nameInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            className="selectable w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
          />
        </label>

        <div>
          <div className="mb-1 text-[11px] text-ink-faint">Listen in these channels</div>
          <div className="flex flex-wrap gap-1">
            {channels.length > 0 ? (
              channels.map((channel) => (
                <Choice
                  key={channel}
                  label={`#${channel}`}
                  selected={selectedChannels.includes(channel)}
                  onClick={() =>
                    setSelectedChannels((held) =>
                      toggle(held, channel, held.includes(channel)),
                    )
                  }
                />
              ))
            ) : (
              <span className="text-[11px] text-ink-faint">Open a channel tab first.</span>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] text-ink-faint">
            Listen for mentions of your accounts
          </div>
          <div className="flex flex-wrap gap-1">
            {accounts.length > 0 ? (
              accounts.map((account) => (
                <Choice
                  key={account.id}
                  label={account.login}
                  selected={selectedAccounts.includes(account.id)}
                  onClick={() =>
                    setSelectedAccounts((held) =>
                      toggle(held, account.id, held.includes(account.id)),
                    )
                  }
                />
              ))
            ) : (
              <span className="text-[11px] text-ink-faint">
                Sign in to listen for mentions of one of your accounts.
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] text-ink-faint">
            Listen for messages from other users
          </div>
          <div className="relative flex gap-1">
            <input
              ref={userInput}
              value={user}
              onChange={(event) => {
                setUser(event.target.value);
                setUserSelected(0);
                setUserDismissedFor(null);
              }}
              onFocus={() => setUserFocused(true)}
              onBlur={() => setUserFocused(false)}
              onKeyDown={(event) => {
                if (userPickerOpen) {
                  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  if (step !== 0) {
                    event.preventDefault();
                    setUserSelected(
                      (userHighlighted + step + userMatches.length) % userMatches.length,
                    );
                    return;
                  }
                  if (event.key === "Tab" || event.key === "Enter") {
                    event.preventDefault();
                    pickUser(userMatches[userHighlighted]);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setUserDismissedFor(user);
                    return;
                  }
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  addUser();
                }
              }}
              placeholder="Add a username"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="selectable min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <button
              type="button"
              onClick={addUser}
              disabled={!user.trim()}
              className="rounded-md border border-line px-2 text-[11px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              Add
            </button>
            {userPickerOpen && (
              <ChatterPicker
                matches={userMatches}
                selected={userHighlighted}
                placement="below"
                onSelect={setUserSelected}
                onPick={pickUser}
              />
            )}
          </div>
          {users.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {users.map((login) => (
                <button
                  key={login}
                  type="button"
                  onClick={() => setUsers((held) => held.filter((value) => value !== login))}
                  title="Remove user"
                  className="rounded-full bg-line px-2 py-0.5 text-[11px] text-ink-dim hover:text-ink"
                >
                  @{login} ×
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 text-[11px] text-ink-faint">Listen for the phrases</div>
          <div className="flex gap-1">
            <input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addPhrase();
                }
              }}
              placeholder="Add a phrase"
              spellCheck={false}
              autoComplete="off"
              className="selectable min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <button
              type="button"
              onClick={addPhrase}
              disabled={!phrase.trim()}
              className="rounded-md border border-line px-2 text-[11px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              Add
            </button>
          </div>
          {phrases.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {phrases.map((item) => (
                <button
                  key={item.toLocaleLowerCase()}
                  type="button"
                  onClick={() => setPhrases((held) => held.filter((value) => value !== item))}
                  title="Remove phrase"
                  className="rounded-full bg-line px-2 py-0.5 text-[11px] text-ink-dim hover:text-ink"
                >
                  {item} ×
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink-dim">
          <input
            type="checkbox"
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="block text-ink">Notify for matches</span>
            <span className="block text-ink-faint">Play a sound and use the rose tab badge.</span>
          </span>
        </label>

        {error && <div className="text-[11px] text-rose-300">{error}</div>}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy || channels.length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent-dim disabled:opacity-40"
        >
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
