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
import { avatarOf, loginOf, useChat } from "../store/chat";
import {
  chatterQuery,
  findChatters,
  matchChatters,
  type ChatterMatch,
} from "../lib/chatterComplete";
import { EmotePicker } from "./EmotePicker";
import { CommandHint, CommandPicker } from "./CommandPicker";
import { ChatterPicker } from "./ChatterPicker";
import { AccountMenu } from "./AccountMenu";
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
import { ANONYMOUS, type StoredMessage } from "../types";

/**
 * The longest chat message Twitch takes. Counted in code points rather than
 * `String.length`, which counts an emoji as the two UTF-16 units it's stored
 * as -- the same distinction the emote ranges are indexed by.
 */
const MAX_MESSAGE_CHARS = 500;

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
  id,
  capturesTyping = true,
  replyTo,
  onCancelReply,
}: {
  /** The tab being typed into -- which decides both the channel and the account. */
  id: string;
  /** Whether typing anywhere in the window lands here -- see the effect below. */
  capturesTyping?: boolean;
  replyTo?: StoredMessage | null;
  onCancelReply?: () => void;
}) {
  const tab = useChat((state) => state.tabs.find((open) => open.id === id));
  const channel = tab?.channel ?? "";
  const account = tab?.account ?? ANONYMOUS;
  const sendMessage = useChat((state) => state.sendMessage);
  const runCommand = useChat((state) => state.runCommand);
  const auth = useChat((state) => state.auth);
  const login = useChat((state) => loginOf(state, account));
  const avatar = useChat((state) => avatarOf(state, account));
  const ready = useChat((state) => state.ready[id]);
  const emoteEntries = useChat((state) => state.emoteEntries[id]);
  const emoteUses = useChat((state) => state.emoteUses);
  const completeBlacklist = useChat((state) => state.preferences.emoteCompleteBlacklist);
  const avatarMode = useChat((state) => state.preferences.composerAvatarMode);
  const showAvatar = avatarMode !== "none";
  const sentHistory = useChat((state) => state.sentHistory[id]);
  const chatters = useChat((state) => state.chatters[id]);
  // Absent until this tab's USERSTATE lands, which is the safe default: the
  // picker offers fewer commands rather than ones Twitch would refuse.
  const role = useChat((state) => state.roles[id] ?? "viewer");
  /** Where the account picker is open, from a right-click on the input. */
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number } | null>(null);
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
  const [chatterSelected, setChatterSelected] = useState(0);
  /** Where an `@` picker was dismissed, so it stays shut for that token. */
  const [chatterDismissedAt, setChatterDismissedAt] = useState<number | null>(null);
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

  // Sending needs an account, and it's this tab's account that has to have
  // one -- a tab reading anonymously can't speak, whatever the tab beside it
  // is signed in as. Mock mode holds no real token, so it never disables.
  const disabled = IS_TAURI && account === ANONYMOUS;

  // Ready to type in as soon as it appears -- but only in the pane you're
  // working in. A composer mounting in the *other* half of a split window
  // (its pane fell back to another tab when you dragged one out, say) would
  // otherwise take the caret with it, and the focus handler that watches for
  // that would hand it the pane focus too, undoing the click you just made.
  // Read through a ref so becoming the working pane mid-drag doesn't pull
  // focus out of a selection you're making in it.
  const capturesRef = useRef(capturesTyping);
  capturesRef.current = capturesTyping;
  useEffect(() => {
    if (!disabled && capturesRef.current) input.current?.focus();
  }, [disabled]);

  // Emotes are only completable once the channel's sets have landed. The
  // channel-ready event refetches too, which is what picks up Twitch's own
  // emotes after a sign-in; this covers switching to a channel that was
  // already ready before the composer mounted.
  useEffect(() => {
    if (ready && !emoteEntries) void loadEmoteIndex(id);
  }, [id, ready, emoteEntries, loadEmoteIndex]);

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

  // How far past Twitch's limit this line is, measured on what would actually
  // be sent. A command isn't a chat message and isn't held to it -- `/me` is
  // one, which is why it goes out through the send path in the first place.
  const overBy = useMemo(() => {
    if (typed && typed.name !== "me") return 0;
    return [...value.trim()].length - MAX_MESSAGE_CHARS;
  }, [value, typed]);

  // A fresh word to match means a fresh selection, and re-arms a picker that
  // was dismissed on a line you've since retyped.
  useEffect(() => {
    setCommandSelected(0);
  }, [commandTrigger?.query]);
  useEffect(() => {
    if (commandTrigger === null) setCommandDismissed(false);
  }, [commandTrigger]);

  // A username token opens the visible equivalent of the existing `@` Tab
  // completion, using the same per-tab session chatter inventory.
  const chatterTrigger = useMemo(() => chatterQuery(value, caret), [value, caret]);
  const chatterMatches = useMemo(
    () => (chatterTrigger ? findChatters(chatters, chatterTrigger.query).slice(0, 50) : []),
    [chatters, chatterTrigger],
  );
  const chatterOpen =
    chatterTrigger !== null &&
    chatterDismissedAt !== chatterTrigger.start &&
    chatterMatches.length > 0;
  const chatterHighlighted = Math.min(chatterSelected, chatterMatches.length - 1);

  useEffect(() => {
    setChatterSelected(0);
  }, [chatterTrigger?.query, chatterTrigger?.start]);
  useEffect(() => {
    if (chatterTrigger === null) setChatterDismissedAt(null);
  }, [chatterTrigger]);

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
      const problem = IS_TAURI ? commandProblem(command, auth, account) : null;
      if (problem) {
        setError(problem);
        return;
      }

      busy.current = true;
      setError(null);
      try {
        await runCommand(id, text);
        reset();
      } catch (cause) {
        // The text stays put: the usual cause is an argument to fix.
        setError(String(cause));
      } finally {
        busy.current = false;
      }
      return;
    }

    // Twitch would refuse this, and the composer is already saying why.
    // Stopping here keeps that notice up instead of replacing it with
    // Twitch's version of the same sentence a round trip later.
    if ([...text].length > MAX_MESSAGE_CHARS) return;

    const replyInfo = replyTo
      ? { login: replyTo.login, displayName: replyTo.displayName, body: messageText(replyTo) }
      : undefined;

    busy.current = true;
    setError(null);
    try {
      await sendMessage(id, text, replyTo?.id, replyInfo);
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
  // exception -- while one's open, it owns focus and keyboard input. The
  // other is a split window: only the pane you're working in listens, or the
  // two composers would each grab every keystroke from the other. Clicking
  // this one still focuses it in the ordinary way, and focusing a pane is
  // what makes it the one that listens.
  useEffect(() => {
    if (disabled || !capturesTyping) return;

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
  }, [disabled, capturesTyping]);

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

  /** Replace the active `@query` with the selected display name. */
  const pickChatter = (chatter: ChatterMatch) => {
    if (!chatterTrigger) return;
    const completed = applyCompletion(
      value.slice(0, chatterTrigger.start),
      value.slice(caret),
      `@${chatter.name}`,
      ", ",
    );
    completion.current = null;
    pendingCaret.current = completed.caret;
    applyText(completed.value, completed.caret);
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

    if (chatterOpen && chatterTrigger) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        setChatterSelected(
          (chatterHighlighted + step + chatterMatches.length) % chatterMatches.length,
        );
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        pickChatter(chatterMatches[chatterHighlighted]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setChatterDismissedAt(chatterTrigger.start);
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
          account={account}
          selected={commandHighlighted}
          onSelect={setCommandSelected}
          onPick={(match: CommandMatch) => pickCommand(match.name)}
        />
      )}
      {chatterOpen && (
        <ChatterPicker
          matches={chatterMatches}
          selected={chatterHighlighted}
          placement="above"
          onSelect={setChatterSelected}
          onPick={pickChatter}
        />
      )}
      {pickerOpen && (
        <EmotePicker items={items} selected={highlighted} onSelect={setSelected} onPick={pick} />
      )}
      {hinted && typed && <CommandHint command={hinted} name={typed.name} />}
      {replyTo && <ReplyBar message={replyTo} onCancel={() => onCancelReply?.()} />}
      <div className="px-2 py-1.5">
        {/* One slot, and the length wins it: a failed send from a moment ago
            is stale next to the reason the next one won't go either. */}
        {overBy > 0 ? (
          <div className="mb-1 text-[11px] text-rose-400">
            {overBy} character{overBy === 1 ? "" : "s"} over Twitch's {MAX_MESSAGE_CHARS}-character
            limit
          </div>
        ) : (
          error && <div className="mb-1 text-[11px] text-rose-400">{error}</div>
        )}
        <div className="flex items-center gap-2">
          {/* Who this line will be sent as. The placeholder says it too, but
              that's gone the moment you start typing, and with two accounts on
              one channel the tabs look alike -- this is the half of the answer
              that's still there while you type. Clicking it is the same menu
              the right-click opens; `onMouseDown` is swallowed so the caret and
              any selection stay where they were. */}
          {showAvatar && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setAccountMenu({ x: box.left, y: box.bottom });
              }}
              title={login ? `Sending as ${login}` : "Reading anonymously"}
              aria-label={login ? `Sending as ${login}. Change account.` : "Pick an account"}
              className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {avatarMode === "twitch" && avatar ? (
                <img src={avatar} alt="" className="h-7 w-7 rounded-full object-cover" />
              ) : login ? (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-[13px] font-semibold uppercase text-accent">
                  {login.slice(0, avatarMode === "generic" ? 2 : 1)}
                </span>
              ) : (
                // Anonymous has no username to abbreviate, so both visible
                // modes fall back to a silhouette that keeps the account
                // picker reachable.
                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-accent">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <circle cx="8" cy="5.5" r="2.75" />
                    <path d="M2.5 14a5.5 5.5 0 0 1 11 0z" />
                  </svg>
                </span>
              )}
            </button>
          )}
          <input
            ref={input}
            value={value}
            onChange={(event) => {
              // Typing over a recalled message makes it yours again: the next
              // up-arrow starts a fresh walk from the most recent send.
              setHistoryIndex(null);
              applyText(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            // Fires for clicks and arrow keys as well as typing, so the `:`
            // search always knows which word the caret is actually in.
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            // The other half of the tab's right-click: this is the tab speaking,
            // so it's a place you'd reasonably ask "as whom?" and change it.
            onContextMenu={(event) => {
              event.preventDefault();
              setAccountMenu({ x: event.clientX, y: event.clientY });
            }}
            disabled={disabled}
            placeholder={
              // A disabled input takes no mouse events at all, so the
              // right-click this used to name never reached it. The avatar is
              // the control that works here -- and with it switched off, the
              // tab's own right-click is what's left.
              disabled
                ? showAvatar
                  ? "Click the avatar to send as an account"
                  : "Right-click the tab to send as an account"
                : login
                  ? `Message #${channel} as ${login}`
                  : `Message #${channel}`
            }
            spellCheck={false}
            autoComplete="off"
            // Over the limit the border goes rose and stays rose through
            // focus, the same shade the settings dialog marks a rejected line
            // with -- the accent focus ring would otherwise paint over the one
            // state the box is trying to report.
            className={`chat-text selectable min-w-0 flex-1 rounded-lg border bg-surface px-2.5 py-1.5 text-ink outline-none transition-colors placeholder:text-ink-faint disabled:cursor-not-allowed ${
              overBy > 0 ? "border-rose-500/60" : "border-line focus:border-accent/60"
            }`}
          />
        </div>
      </div>

      {accountMenu && (
        <AccountMenu
          tabId={id}
          x={accountMenu.x}
          y={accountMenu.y}
          onClose={() => setAccountMenu(null)}
        />
      )}
    </div>
  );
}
