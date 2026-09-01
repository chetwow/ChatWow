// Aliased: the window-level listeners below take the DOM KeyboardEvent, which
// an unaliased React import would shadow.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useChat } from "../store/chat";
import { matchChatters } from "../lib/chatterComplete";
import { EmotePicker } from "./EmotePicker";
import { CommandHint, CommandPicker } from "./CommandPicker";
import { IS_TAURI } from "../lib/tauri";
import { messageText } from "../lib/messageText";
import { loadEmoji, searchEmoji, type Emoji } from "../lib/emoji";
import {
  applyCompletion,
  itemText,
  pickerQuery,
  rankMatches,
  searchPicker,
  wordBeforeCaret,
  type Completion,
  type PickerItem,
} from "../lib/emoteComplete";
import { filterBlacklisted } from "../lib/emoteBlacklist";
import {
  commandProblem,
  commandQuery,
  findCommand,
  matchCommands,
  splitCommand,
  type CommandMatch,
} from "../lib/commands";
import type { StoredMessage } from "../types";

function ReplyBar({ message, onCancel }: { message: StoredMessage; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
      <div className="min-w-0 flex-1 truncate text-[12px]">
        <span className="text-ink-faint">Replying to </span>
        <span className="font-semibold" style={{ color: message.color }}>
          {message.displayName}
        </span>
        <span className="text-ink-faint">: </span>
        <span className="text-ink-dim">{messageText(message)}</span>
      </div>
      <button
        onClick={onCancel}
        aria-label="Cancel reply"
        className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function Composer({
  channel,
  replyTo,
  onCancelReply,
}: {
  channel: string;
  replyTo?: StoredMessage | null;
  onCancelReply?: () => void;
}) {
  const sendMessage = useChat((state) => state.sendMessage);
  const runCommand = useChat((state) => state.runCommand);
  const auth = useChat((state) => state.auth);
  const ready = useChat((state) => state.ready[channel]);
  const emoteEntries = useChat((state) => state.emoteEntries[channel]);
  const emoteUses = useChat((state) => state.emoteUses);
  const completeBlacklist = useChat((state) => state.preferences.emoteCompleteBlacklist);
  const sentHistory = useChat((state) => state.sentHistory[channel]);
  const chatters = useChat((state) => state.chatters[channel]);
  // Absent until this channel's USERSTATE lands, which is the safe default:
  // the picker offers fewer commands rather than ones Twitch would refuse.
  const role = useChat((state) => state.roles[channel] ?? "viewer");
  const loadEmoteIndex = useChat((state) => state.loadEmoteIndex);
  const [value, setValue] = useState("");
  /** Mirrors the input's caret, so the `:` search knows which word it's in. */
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  /** Where a picker Escape'd out of started, so it stays shut for that word. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [commandSelected, setCommandSelected] = useState(0);
  /** Whether the command picker was Escape'd out of for the line being typed. */
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [emoji, setEmoji] = useState<Emoji[]>([]);
  /**
   * How far back through this channel's sent messages the arrows have walked:
   * 0 is the most recent one, null means the input holds your own draft.
   */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  /** The run of Tab presses currently cycling one half-typed word. */
  const completion = useRef<Completion | null>(null);
  /** Caret position to restore once React has rendered a completion. */
  const pendingCaret = useRef<number | null>(null);
  /** What was typed before the arrows started replacing it, to come back to. */
  const draft = useRef("");

  /** Set the input's text and where the caret lands in it. */
  const applyText = (next: string, nextCaret: number) => {
    setValue(next);
    setCaret(nextCaret);
  };

  const history = sentHistory ?? [];

  /**
   * Replace the input with the history entry `index` steps back from the most
   * recent (or the saved draft, at null), caret at the end.
   */
  const recall = (index: number | null) => {
    const text = index === null ? draft.current : history[history.length - 1 - index];
    setHistoryIndex(index);
    completion.current = null;
    pendingCaret.current = text.length;
    applyText(text, text.length);
  };

  // Real builds need a signed-in user to chat; mock mode never is signed in,
  // so it would otherwise be impossible to exercise the composer's design.
  const disabled = IS_TAURI && !auth.loggedIn;

  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);

  // Emotes are only completable once the channel's sets have landed. The
  // channel-ready event refetches too, which is what picks up Twitch's own
  // emotes after a sign-in; this covers switching to a channel that was
  // already ready before the composer mounted.
  useEffect(() => {
    if (ready && !emoteEntries) void loadEmoteIndex(channel);
  }, [channel, ready, emoteEntries, loadEmoteIndex]);

  // React resets the caret to the end of a controlled input when its value
  // changes, so a completion inserted mid-line has to put it back.
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (pending === null) return;
    pendingCaret.current = null;
    input.current?.setSelectionRange(pending, pending);
  }, [value]);

  // The command word being typed, if any -- the `/` picker's whole trigger. It
  // can only be the first word of the line, so it and the `:` picker below can
  // never both be open.
  const commandTrigger = useMemo(() => commandQuery(value, caret), [value, caret]);
  const commandMatches = useMemo(
    () => (commandTrigger ? matchCommands(commandTrigger.query, role) : []),
    [commandTrigger, role],
  );
  const commandOpen = commandTrigger !== null && !commandDismissed && commandMatches.length > 0;
  const commandHighlighted = Math.min(commandSelected, commandMatches.length - 1);

  // The command you've finished typing the name of, so its arguments stay in
  // front of you while you fill them in.
  const typed = useMemo(() => splitCommand(value), [value]);
  const hinted = typed && !commandOpen ? findCommand(typed.name) : null;

  // A fresh word to match means a fresh selection, and re-arms a picker that
  // was dismissed on a line you've since retyped.
  useEffect(() => {
    setCommandSelected(0);
  }, [commandTrigger?.query]);
  useEffect(() => {
    if (commandTrigger === null) setCommandDismissed(false);
  }, [commandTrigger]);

  // The `:` token being typed, if any -- this is the picker's whole trigger.
  const trigger = useMemo(() => pickerQuery(value, caret), [value, caret]);
  const query = trigger?.query ?? "";

  // Emoji only join the search once there are letters to match, so their data
  // is fetched on the first such keystroke and never in a bare `:` list.
  useEffect(() => {
    if (query) void loadEmoji().then(setEmoji);
  }, [query]);

  // Filtered once, upstream of both completion paths, so Tab and the `:` picker
  // can't disagree about what's suggestable.
  const completable = useMemo(
    () => filterBlacklisted(emoteEntries ?? [], completeBlacklist),
    [emoteEntries, completeBlacklist],
  );

  const search = useCallback(
    (text: string) =>
      searchPicker(completable, text, emoteUses, text ? searchEmoji(emoji, text) : []),
    [completable, emoteUses, emoji],
  );

  const items = useMemo(() => (trigger ? search(query) : []), [trigger, query, search]);

  // An empty result set closes the picker rather than showing an empty box --
  // which is also what makes typing ":)" feel like plain text.
  const pickerOpen = trigger !== null && dismissedAt !== trigger.start && items.length > 0;
  // The reset to 0 lands an effect later, so a shrinking result list would
  // otherwise leave the selection past the end for a frame.
  const highlighted = Math.min(selected, items.length - 1);

  // A new word to search means a fresh selection, and re-arms a picker that
  // was dismissed on the previous one.
  useEffect(() => {
    setSelected(0);
  }, [query, trigger?.start]);
  useEffect(() => {
    if (trigger === null) setDismissedAt(null);
  }, [trigger]);

  // Replying focuses the composer, same as clicking into it.
  useEffect(() => {
    if (replyTo && !disabled) input.current?.focus();
  }, [replyTo, disabled]);

  // Escape cancels an in-progress reply. Kept separate from the window
  // keydown listener below, which never sees Escape (it bails out before
  // that check for any key that isn't Enter/Backspace/a single character).
  useEffect(() => {
    if (!replyTo) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The picker takes Escape first when it's open, to close itself.
      if (event.key === "Escape" && !event.defaultPrevented) onCancelReply?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [replyTo, onCancelReply]);

  /** Clear the composer the way a successful send or command does. */
  const reset = () => {
    applyText("", 0);
    completion.current = null;
    draft.current = "";
    setHistoryIndex(null);
  };

  const submit = async () => {
    const text = value.trim();
    if (!text || busy.current) return;

    // `/me` is a message rather than a command -- it goes out through the send
    // path like any other text, and Twitch renders it as an action. Everything
    // else starting with a slash is a Helix call; Twitch stopped accepting
    // commands over IRC, so sending one as text would just post it.
    const parsed = splitCommand(text);
    if (parsed && parsed.name !== "me") {
      const command = findCommand(parsed.name);
      if (!command) {
        setError(`Unknown command: /${parsed.name}. Type /help for the list.`);
        return;
      }
      // Checked here as well as in the picker: a command can be typed straight
      // out, and a refusal that names the missing permission beats Twitch's.
      const problem = IS_TAURI ? commandProblem(command, auth) : null;
      if (problem) {
        setError(problem);
        return;
      }

      busy.current = true;
      setError(null);
      try {
        await runCommand(channel, text);
        reset();
      } catch (cause) {
        // The text stays put: the usual cause is an argument to fix.
        setError(String(cause));
      } finally {
        busy.current = false;
      }
      return;
    }

    const replyInfo = replyTo
      ? { login: replyTo.login, displayName: replyTo.displayName, body: messageText(replyTo) }
      : undefined;

    busy.current = true;
    setError(null);
    try {
      await sendMessage(channel, text, replyTo?.id, replyInfo);
      reset();
      onCancelReply?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      busy.current = false;
    }
  };

  // The window listener below is only re-subscribed when `disabled` changes,
  // so it'd otherwise close over a stale `submit` (and thus a stale `value`)
  // from whenever it was last attached. Route through a ref that's always
  // current instead of adding `value` to the effect's deps, which would mean
  // tearing down and re-adding a window listener on every keystroke.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Chat should feel always-focused, like a game's chat box: clicking
  // somewhere else in the app shouldn't lose your typed text or make Enter
  // stop working. A dialog (add-channel, account settings) is the one real
  // exception -- while one's open, it owns focus and keyboard input.
  useEffect(() => {
    if (disabled) return;

    const isForeignTextField = (el: Element | null) =>
      el !== input.current &&
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Already handled by the input itself -- an Enter that took an emote out
      // of the picker must not also send the message.
      if (event.defaultPrevented) return;
      if (document.querySelector("[data-modal]")) return;
      if (isForeignTextField(document.activeElement)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const isEnter = event.key === "Enter";
      if (!isEnter && event.key.length !== 1 && event.key !== "Backspace") return;

      // Reclaim focus (and put the caret back at the end, not the start) only
      // when it isn't already here -- don't disturb the caret mid-message.
      if (document.activeElement !== input.current) {
        const el = input.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }

      if (isEnter) {
        event.preventDefault();
        void submitRef.current();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [disabled]);

  /**
   * Replace the half-typed command word with the picked one, leaving whatever
   * arguments are already on the line alone. The trailing space is what the
   * caret lands after, so you carry straight on into the first argument.
   */
  const pickCommand = (name: string) => {
    const end = value.search(/\s/);
    const tail = end === -1 ? " " : value.slice(end);
    const next = `/${name}${tail}`;
    const nextCaret = name.length + 2;
    completion.current = null;
    pendingCaret.current = nextCaret;
    applyText(next, nextCaret);
    input.current?.focus();
  };

  /** Swap the `:query` token for what the picked row inserts. */
  const pick = (item: PickerItem) => {
    if (!trigger) return;
    const completed = applyCompletion(
      value.slice(0, trigger.start),
      value.slice(caret),
      itemText(item),
    );
    completion.current = null;
    pendingCaret.current = completed.caret;
    applyText(completed.value, completed.caret);
    // Clicking a row moves focus to it; typing should carry on in the composer.
    input.current?.focus();
  };

  /**
   * Tab completes the word at the caret to an emote name; pressing it again
   * cycles through the rest of the matches (Shift+Tab goes back) and wraps
   * around. Anything that changes the input -- typing, clicking elsewhere in
   * the line -- ends the run, so the next Tab starts a fresh search.
   *
   * While the `:` picker is open it takes these keys first: arrows move the
   * selection, Tab and Enter take it, Escape closes the picker (and only the
   * picker -- an in-progress reply survives).
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // The command picker takes these keys first when it's open. It only ever
    // is while the caret is in the first word, so it can't be competing with
    // the emote picker below.
    if (commandOpen && commandTrigger) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        setCommandSelected((commandHighlighted + step + commandMatches.length) % commandMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandDismissed(true);
        return;
      }
      const picked = commandMatches[commandHighlighted].name;
      // Enter completes what you'd otherwise have to finish typing -- but a
      // name already typed in full has nothing to complete, so `/clear` and
      // Enter runs it rather than making you press Enter twice.
      const completes = picked !== commandTrigger.query.toLowerCase();
      if (event.key === "Tab" || (event.key === "Enter" && completes)) {
        event.preventDefault();
        pickCommand(picked);
        return;
      }
    }

    if (pickerOpen) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        setSelected((highlighted + step + items.length) % items.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        pick(items[highlighted]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(trigger.start);
        return;
      }
    }

    // With the picker closed the arrows walk this channel's sent messages,
    // oldest-ward on up. Coming back down past the newest one restores
    // whatever was half-typed when the walk started.
    if (event.key === "ArrowUp") {
      if (history.length === 0) return;
      event.preventDefault();
      if (historyIndex === null) draft.current = value;
      recall(Math.min(historyIndex === null ? 0 : historyIndex + 1, history.length - 1));
      return;
    }
    if (event.key === "ArrowDown") {
      if (historyIndex === null) return;
      event.preventDefault();
      recall(historyIndex === 0 ? null : historyIndex - 1);
      return;
    }

    if (event.key !== "Tab") return;
    // Tab belongs to the composer; it should never walk focus out of chat.
    event.preventDefault();

    const element = input.current;
    if (!element) return;
    const active = completion.current;
    const cycling =
      active !== null &&
      active.value === value &&
      active.caret === caret &&
      element.selectionEnd === caret;

    let next: Completion;
    if (cycling) {
      const step = event.shiftKey ? -1 : 1;
      const index = (active.index + step + active.matches.length) % active.matches.length;
      next = { ...active, index };
    } else {
      const { start, word } = wordBeforeCaret(value, caret);
      // A word starting with `@` completes to someone who has talked here and
      // nothing else, landing with a comma after it -- what you're almost
      // always typing next is either another name or the message.
      //
      // Any other word is the quick complete: matching emotes first, in the
      // usual most-used-then-alphabetical order, then the chatters whose name
      // starts the same way. No emoji and no picker -- this is the path for
      // when you already know what you're typing. The Set keeps it to distinct
      // text: two emotes can share a name, and a chatter can be named after
      // one, and either would otherwise cycle through the same word twice.
      const mentioning = word.startsWith("@");
      const matches = mentioning
        ? matchChatters(chatters, word.slice(1)).map((name) => `@${name}`)
        : word
          ? [
              ...new Set([
                ...rankMatches(completable, word, emoteUses).map((entry) => entry.name),
                ...matchChatters(chatters, word),
              ]),
            ]
          : [];
      if (matches.length === 0) {
        completion.current = null;
        return;
      }
      next = {
        head: value.slice(0, start),
        tail: value.slice(caret),
        matches,
        index: 0,
        suffix: mentioning ? ", " : " ",
        value,
        caret,
      };
    }

    const completed = applyCompletion(
      next.head,
      next.tail,
      next.matches[next.index],
      next.suffix,
    );
    completion.current = { ...next, value: completed.value, caret: completed.caret };
    pendingCaret.current = completed.caret;
    applyText(completed.value, completed.caret);
  };

  return (
    <div className="relative shrink-0 border-t border-line bg-surface-raised">
      {commandOpen && (
        <CommandPicker
          matches={commandMatches}
          auth={auth}
          selected={commandHighlighted}
          onSelect={setCommandSelected}
          onPick={(match: CommandMatch) => pickCommand(match.name)}
        />
      )}
      {pickerOpen && (
        <EmotePicker items={items} selected={highlighted} onSelect={setSelected} onPick={pick} />
      )}
      {hinted && typed && <CommandHint command={hinted} name={typed.name} />}
      {replyTo && <ReplyBar message={replyTo} onCancel={() => onCancelReply?.()} />}
      <div className="px-2 py-1.5">
        {error && <div className="mb-1 text-[11px] text-rose-400">{error}</div>}
        <input
          ref={input}
          value={value}
          onChange={(event) => {
            // Typing over a recalled message makes it yours again: the next
            // up-arrow starts a fresh walk from the most recent send.
            setHistoryIndex(null);
            applyText(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          // Fires for clicks and arrow keys as well as typing, so the `:`
          // search always knows which word the caret is actually in.
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={disabled ? "Sign in to chat" : `Message #${channel}`}
          spellCheck={false}
          autoComplete="off"
          className="chat-text selectable w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-ink outline-none transition-colors focus:border-accent/60 placeholder:text-ink-faint disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
