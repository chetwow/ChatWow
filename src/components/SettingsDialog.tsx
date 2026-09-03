import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { IS_TAURI, TITLE_BAR_PX } from "../lib/tauri";
import { useChat, type BlacklistKind } from "../store/chat";
import { AccountPanel } from "./AccountPanel";
import { EmoteImage } from "./EmoteImage";
import { Hinted } from "./Hinted";
import { imageKey, ruleKey } from "../lib/emoteBlacklist";
import { normalizeIgnore } from "../lib/ignores";
import { NEW_TAB_AVATAR_MODES } from "../lib/tabAvatar";
import type { ChatFontSize, EmoteEntry, EmoteRule, NewTabAvatarMode } from "../types";

export type SettingsTab = "general" | "account" | "appearance" | "notifications" | "emotes";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "account", label: "Accounts" },
  { id: "appearance", label: "Appearance" },
  { id: "emotes", label: "Emotes" },
  { id: "notifications", label: "Notifications" },
];

const FONT_SIZES: { id: ChatFontSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
  { id: "larger", label: "Larger" },
];

/** The px each preset maps to. Mirrored by `--chat-font-size` in App. */
export const FONT_SIZE_PX: Record<ChatFontSize, number> = {
  small: 12,
  medium: 13,
  large: 15,
  larger: 17,
};

/**
 * One labelled setting. The control wraps under the label rather than squeezing
 * beside it, which is what keeps these rows readable at the window's 420px
 * minimum width.
 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1">
      <div className="min-w-0">
        {hint ? (
          <Hinted hint={hint} className="text-[12px] text-ink">
            {label}
          </Hinted>
        ) : (
          <span className="text-[12px] text-ink">{label}</span>
        )}
      </div>
      {/* `ml-auto` rather than relying on `justify-between`: once the row
          wraps, the control is alone on its line and would otherwise sit
          left. Controls stay on the right edge at every width. */}
      <div className="ml-auto shrink-0">{children}</div>
    </div>
  );
}

/**
 * A group of settings under a heading. The heading is a small caps label
 * rather than a bold line of body text: several of these stack in one panel,
 * and at the old size a section title read like another setting's name. It's
 * also the only separator these groups need -- the rows themselves carry no
 * rules, so a short group reads as a list rather than a table.
 */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {hint ? <Hinted hint={hint}>{title}</Hinted> : title}
      </h3>
      <div>{children}</div>
    </div>
  );
}

/**
 * A section that starts closed. For the things you go looking for rather than
 * the things you browse: leaving them open would push everything above them
 * further from the top of the panel for no one's benefit.
 *
 * Closed on every open of the dialog rather than remembering. Whether a
 * disclosure was left open isn't worth a preference, and a settings panel that
 * looks different each time it opens is harder to navigate than one that
 * doesn't.
 */
function CollapsibleSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <h3>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mb-1 flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-ink-dim"
        >
          {/* Rotated rather than swapped for a second glyph, so the arrow
              turns into place instead of blinking. */}
          <svg
            viewBox="0 0 16 16"
            width="9"
            height="9"
            fill="currentColor"
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <path d="M5 2.5 12 8l-7 5.5z" />
          </svg>
          {title}
        </button>
      </h3>
      {open && <div>{children}</div>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left] ${
          checked ? "left-[14px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function SegmentedFontSize({
  value,
  onChange,
}: {
  value: ChatFontSize;
  onChange: (next: ChatFontSize) => void;
}) {
  return (
    <div className="flex rounded-md border border-line p-0.5">
      {FONT_SIZES.map((size) => (
        <button
          key={size.id}
          onClick={() => onChange(size.id)}
          aria-pressed={value === size.id}
          className={`rounded px-2 py-1 text-[11px] transition-colors ${
            value === size.id
              ? "bg-accent/20 font-semibold text-accent"
              : "text-ink-dim hover:bg-surface-hover hover:text-ink"
          }`}
        >
          {size.label}
        </button>
      ))}
    </div>
  );
}

/** How many search hits the add box offers at once. */
const MAX_SUGGESTIONS = 8;

const PROVIDER_LABEL: Record<string, string> = { twitch: "Twitch", "7tv": "7TV" };

/**
 * Every loaded channel's emotes in one list, so the add box can reach an emote
 * you saw in another tab. Deduped by image *and* name: the same 7TV emote
 * aliased differently in two channels is two separate things to blacklist.
 *
 * Re-sorted at the end rather than left as the per-channel blocks it's built
 * from. Each channel arrives sorted, but concatenating them isn't, so results
 * from different channels would otherwise interleave in join order.
 */
function useAllEmotes(): EmoteEntry[] {
  const emoteEntries = useChat((state) => state.emoteEntries);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: EmoteEntry[] = [];
    for (const entries of Object.values(emoteEntries)) {
      for (const entry of entries) {
        const key = `${entry.provider}-${entry.id}-${entry.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }, [emoteEntries]);
}

/** The loaded emote a rule refers to, if any channel still knows it. */
function emoteFor(rule: EmoteRule, all: EmoteEntry[]): EmoteEntry | undefined {
  return all.find((entry) =>
    rule.kind === "id" ? imageKey(entry) === rule.value : entry.name === rule.value,
  );
}

function KindChip({ kind }: { kind: EmoteRule["kind"] }) {
  return (
    <span className="shrink-0 rounded-[3px] bg-line px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-ink-dim">
      {kind}
    </span>
  );
}

/**
 * One rule, with the emote's picture beside it whenever a joined channel still
 * carries it -- a bare 7TV id is otherwise unrecognizable a month later.
 */
function RuleRow({
  rule,
  emote,
  onRemove,
}: {
  rule: EmoteRule;
  emote?: EmoteEntry;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0">
      <span className="grid h-7 w-7 shrink-0 place-items-center">
        {emote ? (
          <EmoteImage
            id={emote.id}
            provider={emote.provider}
            url={emote.url}
            name={emote.name}
            className="max-h-7 max-w-7 object-contain"
          />
        ) : (
          <span className="text-[13px] text-ink-faint">?</span>
        )}
      </span>
      <KindChip kind={rule.kind} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={rule.value}>
        {rule.value}
      </span>
      {emote && rule.kind === "id" && (
        <span className="shrink-0 text-[10px] text-ink-faint">{emote.name}</span>
      )}
      <button
        onClick={onRemove}
        aria-label={`Remove ${rule.value} from the blacklist`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink"
      >
        <svg width="8" height="8" viewBox="0 0 10 10">
          <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
        </svg>
      </button>
    </li>
  );
}

/** The name/id pair that adds a candidate, greyed once it's already listed. */
function AddButtons({
  rules,
  candidates,
  onAdd,
}: {
  rules: EmoteRule[];
  candidates: EmoteRule[];
  onAdd: (rule: EmoteRule) => void;
}) {
  return (
    <span className="flex shrink-0 gap-1">
      {candidates.map((rule) => {
        const listed = rules.some((existing) => ruleKey(existing) === ruleKey(rule));
        return (
          <button
            key={rule.kind}
            disabled={listed}
            onClick={() => onAdd(rule)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
              listed
                ? "cursor-default text-ink-faint"
                : "bg-accent/15 text-accent hover:bg-accent/25"
            }`}
          >
            {listed ? "Added" : rule.kind}
          </button>
        );
      })}
    </span>
  );
}

/**
 * A plain list of names you can add to and remove from -- the ignore list and
 * the blocked list, which differ only in what counts as a valid entry. Rejected
 * input reddens the box rather than throwing a sentence at you: the placeholder
 * already says the shape, and the only way to get it wrong is a typo.
 */
/**
 * Reveals the log folder in the file manager. It reports the path on success
 * rather than saying nothing: on a machine with nothing registered to open a
 * folder the reveal is a no-op, and a path you can read is the fallback.
 */
function LogFolderButton() {
  const [path, setPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={async () => {
          try {
            setPath(await api.openLogDir());
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
        className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25"
      >
        Show
      </button>
      {(path || failed) && (
        <span
          className={`selectable max-w-[260px] truncate text-[10px] ${
            failed ? "text-rose-400" : "text-ink-faint"
          }`}
          title={path ?? undefined}
        >
          {failed ? "Couldn't open it" : path}
        </span>
      )}
    </div>
  );
}

/**
 * Where to send someone whose build can't update itself. The same repo the
 * updater endpoint in `tauri.conf.json` points at -- this is the page a person
 * reads, that one is the file the app reads.
 */
const RELEASES_URL = "https://github.com/chetwow/ChatWow/releases/latest";

/**
 * The version, and the one button the whole update flow needs.
 *
 * Same shape as `LogFolderButton` above -- a pill and a line under it -- since
 * it answers the same kind of question. The button's job changes with the
 * stage rather than there being three buttons, because at most one of them is
 * ever the thing to do next.
 *
 * There's no `ready` on Windows: the installer takes the process with it and
 * puts the app back up, so the restart is never asked for. Nothing here has to
 * know that -- the state simply never arrives.
 */
function UpdateButton() {
  const update = useChat((state) => state.update);
  const refreshUpdate = useChat((state) => state.refreshUpdate);
  const checkForUpdate = useChat((state) => state.checkForUpdate);
  const installUpdate = useChat((state) => state.installUpdate);
  const restartForUpdate = useChat((state) => state.restartForUpdate);

  // The launch check may have finished long before this dialog was opened.
  useEffect(() => {
    void refreshUpdate();
  }, [refreshUpdate]);

  const percent =
    update.total && update.total > 0
      ? Math.min(100, Math.round((update.downloaded / update.total) * 100))
      : null;

  const [action, line] = ((): [(() => void) | null, string] => {
    switch (update.stage) {
      case "checking":
        return [null, "Checking..."];
      case "upToDate":
        return [checkForUpdate, `${update.currentVersion} -- up to date`];
      case "available":
        // A build that can't replace itself -- macOS, until it's signed. The
        // version is still worth knowing, so the button points at the page to
        // get it from rather than going dead.
        return [
          update.canInstall
            ? installUpdate
            : () => void (IS_TAURI ? openUrl(RELEASES_URL) : window.open(RELEASES_URL)),
          `${update.version} is available`,
        ];
      case "downloading":
        return [null, percent === null ? "Downloading..." : `Downloading... ${percent}%`];
      case "ready":
        return [restartForUpdate, "Restart to finish"];
      case "failed":
        return [checkForUpdate, update.error ?? "Couldn't check"];
      default:
        return [checkForUpdate, update.currentVersion];
    }
  })();

  const label =
    update.stage === "available"
      ? update.canInstall
        ? "Install"
        : "Get it"
      : update.stage === "ready"
        ? "Restart"
        : "Check";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => action?.()}
        disabled={action === null}
        className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40 disabled:hover:bg-accent/15"
      >
        {label}
      </button>
      <span
        className={`selectable max-w-[260px] truncate text-[10px] ${
          update.stage === "failed" ? "text-rose-400" : "text-ink-faint"
        }`}
        title={update.notes ?? undefined}
      >
        {line}
      </span>
    </div>
  );
}

function NameListEditor({
  entries,
  placeholder,
  empty,
  parse,
  onAdd,
  onRemove,
  format = (entry: string) => entry,
}: {
  entries: string[];
  placeholder: string;
  empty: string;
  /** What was typed, as an entry -- or null if it isn't one. */
  parse: (raw: string) => string | null;
  onAdd: (entry: string) => void;
  onRemove: (entry: string) => void;
  format?: (entry: string) => string;
}) {
  const [text, setText] = useState("");
  const [rejected, setRejected] = useState(false);

  const submit = () => {
    const entry = parse(text);
    if (!entry) {
      setRejected(text.trim().length > 0);
      return;
    }
    onAdd(entry);
    setText("");
    setRejected(false);
  };

  return (
    <div>
      <div className="flex gap-1">
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setRejected(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={`selectable min-w-0 flex-1 rounded-md border bg-surface px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint ${
            rejected ? "border-rose-500/60" : "border-line"
          }`}
        />
        <button
          onClick={submit}
          className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25"
        >
          Add
        </button>
      </div>

      {entries.length === 0 ? (
        // Boxed like the populated list, so the panel doesn't change shape
        // when the first entry lands -- and like the emote lists above it.
        <p className="mt-1.5 rounded-md border border-line px-2 py-2 text-[11px] text-ink-faint">
          {empty}
        </p>
      ) : (
        // Boxed and capped rather than left to grow: a long list would
        // otherwise push the panel's own scrollbar and bury whatever section
        // comes after it.
        <div className="scroller mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line px-2">
          <ul>
            {entries.map((entry) => (
              <li
                key={entry}
                className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                  {format(entry)}
                </span>
                <button
                  onClick={() => onRemove(entry)}
                  aria-label={`Remove ${format(entry)}`}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink"
                >
                  <svg width="8" height="8" viewBox="0 0 10 10">
                    <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One blacklist: an add box that searches the emotes currently loaded, and the
 * rules themselves. The search is a convenience, not the only way in -- the raw
 * row below it adds whatever you typed, so an emote from a channel you're not
 * in is still reachable.
 */
function BlacklistEditor({ list, empty }: { list: BlacklistKind; empty: string }) {
  const rules = useChat((state) => state.preferences[list]);
  const addEmoteRule = useChat((state) => state.addEmoteRule);
  const removeEmoteRule = useChat((state) => state.removeEmoteRule);
  const all = useAllEmotes();
  const [text, setText] = useState("");
  const query = text.trim();

  const suggestions = useMemo(() => {
    if (!query) return [];
    const needle = query.toLowerCase();
    // Exact name first, then names starting with the query, then names merely
    // containing it -- the same ordering `searchPicker` uses, and for the same
    // reason. It matters most for the emotes this feature exists for: a 7TV
    // alias like "0" is a substring of dozens of other names, so a flat
    // `includes` buries the emote actually called "0" below the cap. Sort is
    // stable, so within a tier the backend's alphabetical order stands.
    const tier = (name: string) => {
      const lower = name.toLowerCase();
      if (lower === needle) return 0;
      return lower.startsWith(needle) ? 1 : 2;
    };
    return all
      .filter((entry) => entry.name.toLowerCase().includes(needle))
      .sort((a, b) => tier(a.name) - tier(b.name))
      .slice(0, MAX_SUGGESTIONS);
  }, [all, query]);

  const add = (rule: EmoteRule) => {
    addEmoteRule(list, rule);
    setText("");
  };

  return (
    <div>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter takes the plain reading -- a name -- which is what you get
          // from typing one out. Ids come from the buttons, never a guess at
          // the shape of the string.
          if (event.key === "Enter" && query) add({ kind: "name", value: query });
        }}
        placeholder="Search loaded emotes, or type a name or id"
        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />

      {query && (
        <ul className="mt-1 rounded-md border border-line">
          {suggestions.map((entry) => (
            <li
              key={`${entry.provider}-${entry.id}-${entry.name}`}
              className="flex items-center gap-2 border-b border-line px-2 py-1 last:border-b-0"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center">
                <EmoteImage
                  id={entry.id}
                  provider={entry.provider}
                  url={entry.url}
                  name={entry.name}
                  className="max-h-7 max-w-7 object-contain"
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{entry.name}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">
                {PROVIDER_LABEL[entry.provider] ?? entry.provider}
              </span>
              <AddButtons
                rules={rules}
                candidates={[
                  { kind: "name", value: entry.name },
                  { kind: "id", value: imageKey(entry) },
                ]}
                onAdd={add}
              />
            </li>
          ))}
          <li className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">
              Add "{query}" as
            </span>
            <AddButtons
              rules={rules}
              candidates={[
                { kind: "name", value: query },
                { kind: "id", value: query },
              ]}
              onAdd={add}
            />
          </li>
        </ul>
      )}

      {rules.length === 0 ? (
        <p className="mt-2 rounded-md border border-line px-2 py-3 text-[11px] text-ink-faint">
          {empty}
        </p>
      ) : (
        // Capped rather than fixed: the dialog's height is shared with the
        // second list, and a few hundred hidden emotes would otherwise push it
        // off the bottom. Short lists still take only the room they need.
        <ul className="scroller mt-2 max-h-[190px] overflow-y-auto rounded-md border border-line px-2">
          {rules.map((rule) => (
            <RuleRow
              key={ruleKey(rule)}
              rule={rule}
              emote={emoteFor(rule, all)}
              onRemove={() => removeEmoteRule(list, rule)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function SettingsDialog({
  tab,
  onChangeTab,
  onClose,
}: {
  tab: SettingsTab;
  onChangeTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const preferences = useChat((state) => state.preferences);
  const updatePreferences = useChat((state) => state.updatePreferences);
  const setMentionIgnored = useChat((state) => state.setMentionIgnored);
  const setUserBlocked = useChat((state) => state.setUserBlocked);

  // Escape closes, matching every other dialog in the app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      // `data-modal` is what stops the composer's window-level key handler
      // from stealing typing while a dialog is open.
      data-modal
      // Below the title bar, not over it: on macOS the traffic lights are drawn
      // by the system on top of everything, so a dialog that reached the top of
      // the window would have them sitting in its corner.
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        // A fixed height, not a max: the dialog shouldn't resize as you move
        // between tabs with more or less in them. It only tracks the window.
        className="flex h-[min(620px,calc(100%-1rem))] w-[min(560px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <h2 className="text-[15px] font-semibold text-ink">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="grid h-6 w-6 place-items-center rounded text-ink-faint hover:bg-surface-hover hover:text-ink"
          >
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" fill="none" />
            </svg>
          </button>
        </div>

        {/* Scrolls sideways rather than wrapping: at the minimum window width
            the row is wider than the dialog, and a second row of tabs would
            push the panel's content off the bottom instead. */}
        <div className="quiet-scroller flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 pb-1.5">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onChangeTab(entry.id)}
              aria-current={entry.id === tab}
              className={`shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors ${
                entry.id === tab
                  ? "bg-surface-hover font-semibold text-ink"
                  : "text-ink-dim hover:bg-surface-hover/60 hover:text-ink"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="scroller min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {tab === "general" && (
            <div className="flex flex-col gap-5">
              <Section title="Chat history">
                <Row label="Show recent message history on join">
                  <Toggle
                    checked={preferences.showMessageHistory}
                    onChange={(showMessageHistory) => updatePreferences({ showMessageHistory })}
                    label="Show recent message history on join"
                  />
                </Row>
              </Section>
              <Section title="Links">
                <Row label="Preview image links">
                  <Toggle
                    checked={preferences.previewImages}
                    onChange={(previewImages) => updatePreferences({ previewImages })}
                    label="Preview image links"
                  />
                </Row>
                <Row label="Preview other links">
                  <Toggle
                    checked={preferences.previewPages}
                    onChange={(previewPages) => updatePreferences({ previewPages })}
                    label="Preview other links"
                  />
                </Row>
              </Section>
              <Section title="Updates">
                <Row label="Check for updates on launch">
                  <Toggle
                    checked={preferences.checkForUpdates}
                    onChange={(checkForUpdates) => updatePreferences({ checkForUpdates })}
                    label="Check for updates on launch"
                  />
                </Row>
                <Row label="Version">
                  <UpdateButton />
                </Row>
              </Section>
              <Section title="Blocked">
                <NameListEditor
                  entries={preferences.blockedUsers}
                  placeholder="Twitch username"
                  empty="Nobody blocked. Right-click a message in chat to add someone."
                  parse={(raw) => {
                    const entry = normalizeIgnore(raw);
                    // Only people can be blocked, so a #channel isn't an entry
                    // here even though the same parser reads it.
                    return entry?.startsWith("@") ? entry.slice(1) : null;
                  }}
                  format={(login) => `@${login}`}
                  onAdd={(login) => setUserBlocked(login, true)}
                  onRemove={(login) => setUserBlocked(login, false)}
                />
              </Section>
              <CollapsibleSection title="Advanced">
                <Row label="Log folder" hint="Safe to attach to a bug report.">
                  <LogFolderButton />
                </Row>
              </CollapsibleSection>
            </div>
          )}

          {tab === "account" && <AccountPanel onDone={onClose} />}

          {tab === "appearance" && (
            <div className="flex flex-col gap-5">
              <Section title="Window">
                <Row label="Keep window on top">
                  <Toggle
                    checked={preferences.alwaysOnTop}
                    onChange={(alwaysOnTop) => updatePreferences({ alwaysOnTop })}
                    label="Keep window on top"
                  />
                </Row>
              </Section>
              {/* No hints on this tab: every row here changes something you can
                  see the moment you flip it, which explains it better than a
                  sentence behind a dot would. */}
              <Section title="Chat">
                <Row label="Font size">
                  <SegmentedFontSize
                    value={preferences.chatFontSize}
                    onChange={(chatFontSize) => updatePreferences({ chatFontSize })}
                  />
                </Row>
                <Row label="Display /me messages in italics">
                  <Toggle
                    checked={preferences.italicActions}
                    onChange={(italicActions) => updatePreferences({ italicActions })}
                    label="Display /me messages in italics"
                  />
                </Row>
                <Row label="Display timestamps">
                  <Toggle
                    checked={preferences.showTimestamps}
                    onChange={(showTimestamps) => updatePreferences({ showTimestamps })}
                    label="Display timestamps"
                  />
                </Row>
                <Row label="Display 7TV badges">
                  <Toggle
                    checked={preferences.showSeventvBadges}
                    onChange={(showSeventvBadges) => updatePreferences({ showSeventvBadges })}
                    label="Display 7TV badges"
                  />
                </Row>
              </Section>
              <Section title="Tabs">
                <Row label="Keep tabs on one row">
                  <Toggle
                    checked={preferences.singleRowTabs}
                    onChange={(singleRowTabs) => updatePreferences({ singleRowTabs })}
                    label="Keep tabs on one row"
                  />
                </Row>
                {/* What a tab *opens* with: an open tab keeps the one it has
                    and changes through its own right-click menu. */}
                <Row label="Default background avatar">
                  {/* `appearance-none` and our own chevron: left native, the
                      control draws in the OS's own light chrome, which is the
                      one thing on this screen that wouldn't be dark. */}
                  <div className="relative">
                    <select
                      value={preferences.newTabAvatarMode}
                      onChange={(event) =>
                        updatePreferences({
                          newTabAvatarMode: event.target.value as NewTabAvatarMode,
                        })
                      }
                      aria-label="Default background avatar"
                      className="w-full appearance-none rounded-md border border-line bg-surface py-1 pl-2 pr-7 text-[11px] text-ink outline-none transition-colors hover:bg-surface-hover focus:border-accent"
                    >
                      {NEW_TAB_AVATAR_MODES.map((mode) => (
                        <option key={mode.id} value={mode.id} className="bg-surface text-ink">
                          {mode.label}
                        </option>
                      ))}
                    </select>
                    <svg
                      viewBox="0 0 10 6"
                      width="8"
                      height="5"
                      aria-hidden
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint"
                    >
                      <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </div>
                </Row>
                {/* Worth a control rather than a constant: how visible a given
                    opacity looks depends entirely on the avatar behind it. */}
                <Row label="Background avatar opacity">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(preferences.tabAvatarOpacity * 100)}
                      onChange={(event) =>
                        updatePreferences({ tabAvatarOpacity: Number(event.target.value) / 100 })
                      }
                      aria-label="Background avatar opacity"
                      className="w-32 accent-accent"
                    />
                    <span className="w-8 text-right text-[11px] tabular-nums text-ink-faint">
                      {Math.round(preferences.tabAvatarOpacity * 100)}%
                    </span>
                  </div>
                </Row>
              </Section>
              <Section title="Message box">
                {/* Off is for a single account, where the picture only repeats
                    what the placeholder says. With two signed in it's the one
                    thing still naming the sender once you've typed over it. */}
                <Row label="Display your Twitch avatar">
                  <Toggle
                    checked={preferences.showComposerAvatar}
                    onChange={(showComposerAvatar) => updatePreferences({ showComposerAvatar })}
                    label="Display your Twitch avatar beside the message box"
                  />
                </Row>
              </Section>
            </div>
          )}

          {tab === "emotes" && (
            <div className="flex flex-col gap-5">
              <Section title="Sources">
                {/* Off means the service is never asked at all, so its emotes
                    leave completion and the words they were drawn from go back
                    to being words. Twitch's own emotes aren't a source you can
                    switch off: they arrive named in the message itself. */}
                <Row label="7TV">
                  <Toggle
                    checked={preferences.enableSeventv}
                    onChange={(enableSeventv) => updatePreferences({ enableSeventv })}
                    label="7TV emotes"
                  />
                </Row>
                <Row label="BetterTTV">
                  <Toggle
                    checked={preferences.enableBttv}
                    onChange={(enableBttv) => updatePreferences({ enableBttv })}
                    label="BetterTTV emotes"
                  />
                </Row>
                <Row label="FrankerFaceZ">
                  <Toggle
                    checked={preferences.enableFfz}
                    onChange={(enableFfz) => updatePreferences({ enableFfz })}
                    label="FrankerFaceZ emotes"
                  />
                </Row>
              </Section>
              <Section title="Miscellaneous">
                {/* Off only stops the line. A set that changes while you're
                    reading still changes what you can type either way. */}
                <Row label="Announce 7TV emote changes">
                  <Toggle
                    checked={preferences.announceEmoteChanges}
                    onChange={(announceEmoteChanges) =>
                      updatePreferences({ announceEmoteChanges })
                    }
                    label="Announce 7TV emote changes"
                  />
                </Row>
              </Section>
              <Section title="Hidden emotes">
                <BlacklistEditor
                  list="emoteBlacklist"
                  empty="Nothing hidden. Right-click an emote in chat to add one."
                />
              </Section>
              <Section title="Hidden from autocomplete">
                <BlacklistEditor
                  list="emoteCompleteBlacklist"
                  empty="Nothing hidden from Tab or the : picker."
                />
              </Section>
            </div>
          )}

          {tab === "notifications" && (
            <div className="flex flex-col gap-5">
              <Section title="Mentions">
                <Row label="Notify when tagged">
                  <Toggle
                    checked={preferences.notifyOnTag}
                    onChange={(notifyOnTag) => updatePreferences({ notifyOnTag })}
                    label="Notify when tagged"
                  />
                </Row>
                <Row label="Notify on your name without the @">
                  <Toggle
                    checked={preferences.notifyOnName}
                    onChange={(notifyOnName) => updatePreferences({ notifyOnName })}
                    label="Notify on your name without the @"
                  />
                </Row>
                <Row label="Notify for active tab">
                  <Toggle
                    checked={preferences.notifyActiveTab}
                    onChange={(notifyActiveTab) => updatePreferences({ notifyActiveTab })}
                    label="Notify for active tab"
                  />
                </Row>
                <Row label="Warn before closing listened channels">
                  <Toggle
                    checked={preferences.warnOnListenerClose}
                    onChange={(warnOnListenerClose) =>
                      updatePreferences({ warnOnListenerClose })
                    }
                    label="Warn before closing listened channels"
                  />
                </Row>
              </Section>
              <Section title="Ignored">
                <NameListEditor
                  entries={preferences.mentionIgnores}
                  placeholder="@user or #channel"
                  empty="Nothing ignored. Right-click a message in chat to add someone."
                  parse={normalizeIgnore}
                  onAdd={(entry) => setMentionIgnored(entry, true)}
                  onRemove={(entry) => setMentionIgnored(entry, false)}
                />
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
