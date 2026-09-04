import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { IS_TAURI, MOCK_MODE } from "../lib/tauri";
import { emotesIn } from "../lib/emoteComplete";
import type { Chatters } from "../lib/chatterComplete";
import { isAboutYou, mentionKind } from "../lib/mentions";
import { normalizeRules, withRule, withoutRule } from "../lib/emoteBlacklist";
import {
  mentionIgnored,
  normalizeIgnores,
  normalizeLogins,
  userBlocked,
  withEntry,
  withoutEntry,
} from "../lib/ignores";
import { helpLines, splitCommand } from "../lib/commands";
import { localNotice } from "../lib/notice";
import { playMentionSound } from "../lib/notify";
import { messageCleared } from "../lib/moderation";
import { messageText } from "../lib/messageText";
import { DEFAULT_TIMEOUT_SECONDS, validTimeout } from "../lib/timeout";
import { ANONYMOUS } from "../types";
import type {
  AuthStatus,
  Badge,
  UpdateState,
  ChannelRole,
  RoleEvent,
  EmoteRule,
  Preferences,
  EmoteEntry,
  ChannelReadyEvent,
  ChatMessage,
  EmoteSetEvent,
  ClearEvent,
  ConnectionState,
  PaneIndex,
  ReplyInfo,
  NewTabAvatarMode,
  MentionFilter,
  SplitLayout,
  TabAvatarMode,
  StatusEvent,
  StoredMessage,
  Tab,
} from "../types";

export { ANONYMOUS };

/** Per-tab backlog cap. Beyond this the oldest messages are dropped. */
const MAX_MESSAGES = 500;
/** Trim in chunks so we're not reallocating the array on every single message. */
const TRIM_SLACK = 100;
/** How many of your own sent messages the up-arrow can walk back through. */
const MAX_SENT_HISTORY = 100;
/** Per-tab cap on remembered chatters, oldest dropped first. */
const MAX_CHATTERS = 1000;

export const DEFAULT_PREFERENCES: Preferences = {
  chatFontSize: "medium",
  notifyOnTag: true,
  notifyOnName: true,
  notifyActiveTab: false,
  warnOnListenerClose: true,
  showMessageHistory: true,
  defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  checkForUpdates: true,
  enableSeventv: true,
  enableBttv: true,
  enableFfz: true,
  showSeventvBadges: true,
  italicActions: true,
  showTimestamps: true,
  alwaysOnTop: false,
  showComposerAvatar: true,
  newTabAvatarMode: "owner",
  tabAvatarOpacity: 0.4,
  previewImages: true,
  previewPages: true,
  singleRowTabs: true,
  splitLayout: "none",
  splitRatio: 0.5,
  splitIndex: 0,
  mentionIgnores: [],
  blockedUsers: [],
  muted: false,
  emoteBlacklist: [],
  emoteCompleteBlacklist: [],
};

/**
 * Before anything has been asked. `currentVersion` is filled in by the first
 * `refreshUpdate`, since only the backend knows what build this is.
 */
const IDLE_UPDATE: UpdateState = {
  stage: "idle",
  currentVersion: "",
  version: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  canInstall: true,
};

/** Which of the two blacklists an operation is about -- keyed by its own preference field. */
export type BlacklistKind = "emoteBlacklist" | "emoteCompleteBlacklist";

const FONT_SIZES = new Set<Preferences["chatFontSize"]>(["small", "medium", "large", "larger"]);
const SPLIT_LAYOUTS = new Set<SplitLayout>(["none", "row", "column"]);
const NEW_TAB_AVATAR_MODE_IDS = new Set<NewTabAvatarMode>([
  "none",
  "owner",
  "account",
  "otherAccount",
]);

/**
 * Coerce whatever the backend hands over into a usable set. `settings.json` is
 * a plain file a user can edit, and Rust deliberately doesn't validate the
 * font-size string -- an unrecognized one lands back on the default here
 * rather than rendering chat at `undefined`.
 */
function normalize(raw: Partial<Preferences> | null | undefined): Preferences {
  const merged = { ...DEFAULT_PREFERENCES, ...raw };
  if (!FONT_SIZES.has(merged.chatFontSize)) merged.chatFontSize = DEFAULT_PREFERENCES.chatFontSize;
  merged.emoteBlacklist = normalizeRules(merged.emoteBlacklist);
  merged.emoteCompleteBlacklist = normalizeRules(merged.emoteCompleteBlacklist);
  merged.mentionIgnores = normalizeIgnores(merged.mentionIgnores);
  merged.blockedUsers = normalizeLogins(merged.blockedUsers);
  if (!validTimeout(merged.defaultTimeoutSeconds)) {
    merged.defaultTimeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  }
  if (!SPLIT_LAYOUTS.has(merged.splitLayout)) merged.splitLayout = DEFAULT_PREFERENCES.splitLayout;
  if (!NEW_TAB_AVATAR_MODE_IDS.has(merged.newTabAvatarMode)) {
    merged.newTabAvatarMode = DEFAULT_PREFERENCES.newTabAvatarMode;
  }
  merged.tabAvatarOpacity = Number.isFinite(merged.tabAvatarOpacity)
    ? Math.min(1, Math.max(0, merged.tabAvatarOpacity))
    : DEFAULT_PREFERENCES.tabAvatarOpacity;
  if (!Number.isFinite(merged.splitRatio)) merged.splitRatio = DEFAULT_PREFERENCES.splitRatio;
  merged.splitRatio = clampRatio(merged.splitRatio);
  if (!Number.isInteger(merged.splitIndex) || merged.splitIndex < 0) {
    merged.splitIndex = DEFAULT_PREFERENCES.splitIndex;
  }
  return merged;
}

/**
 * The narrowest either pane can be dragged, as a fraction of the split axis.
 * A pane below this is one you can't read but can still lose tabs into, which
 * is worse than simply refusing to go there.
 */
const MIN_RATIO = 0.15;

export function clampRatio(ratio: number): number {
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Mock mode has no backend to persist to, so it falls back to the webview's
 * own storage -- enough to keep a toggle across a reload while iterating.
 */
const MOCK_KEY = "chatwow.preferences";

function readMockPreferences(): Preferences {
  try {
    return normalize(JSON.parse(localStorage.getItem(MOCK_KEY) ?? "null"));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function writeMockPreferences(preferences: Preferences) {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable or blocked; the change still holds for this run.
  }
}

let nextKey = 1;

/** Both panes, for iterating -- there are exactly two, never a tree of them. */
export const PANES: readonly PaneIndex[] = [0, 1];

/** A tab id, minted here: the view has a key before the backend has heard of it. */
function newTabId(): string {
  return crypto.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The pieces the pane layout is derived from, and all it needs to be derived. */
type Layout = { tabs: Tab[]; preferences: Preferences };

/**
 * The tabs in one pane, in bar order. `splitIndex` is the boundary in the one
 * `tabs` list rather than a second list of its own: that list is the backend's
 * record of what's open and in what order, and keeping the split as a position
 * in it means dragging a tab across the divider is an ordinary move within it
 * -- nothing can end up in both panes, or in neither.
 *
 * Unsplit, everything is in the first pane and the second is empty.
 */
export function paneTabs(layout: Layout, pane: PaneIndex): Tab[] {
  if (layout.preferences.splitLayout === "none") return pane === 0 ? layout.tabs : [];
  const at = Math.min(layout.preferences.splitIndex, layout.tabs.length);
  return pane === 0 ? layout.tabs.slice(0, at) : layout.tabs.slice(at);
}

/** Which pane a tab is in, or `null` for one that isn't open anywhere. */
export function paneOf(layout: Layout, id: string): PaneIndex | null {
  for (const pane of PANES) {
    if (paneTabs(layout, pane).some((tab) => tab.id === id)) return pane;
  }
  return null;
}

export function tabById(layout: { tabs: Tab[] }, id: string | null): Tab | undefined {
  return id ? layout.tabs.find((tab) => tab.id === id) : undefined;
}

/**
 * The login a tab reads as, or null when it's anonymous.
 *
 * What decides whether a message names *you* -- which is a per-tab question
 * now, since the same message can be a mention in one tab and nothing at all
 * in the one beside it.
 */
export function loginOf(state: { auth: AuthStatus }, account: string | undefined): string | null {
  if (!account) return null;
  return state.auth.accounts.find((held) => held.id === account)?.login ?? null;
}

/** The visible name of a listener, including the pre-custom-tab fallback. */
export function mentionTabName(tab: Tab): string {
  return tab.mention?.name.trim() || "Mentions";
}

/** A stable identity for collapsing copies received through multiple account sockets. */
function mentionIdentity(message: ChatMessage): string {
  if (message.id) return `${message.channel}\0${message.id}`;
  return [
    message.channel,
    message.ts,
    message.login,
    message.kind,
    message.systemMessage,
    messageText(message),
  ].join("\0");
}

/** Whether a phrase qualifies, excluding anything sent by a signed-in user. */
function listenerPhraseMatches(
  state: Pick<ChatState, "auth">,
  tab: Tab,
  message: ChatMessage,
): boolean {
  if (!tab.mention) return false;
  const sender = message.login.toLocaleLowerCase();
  if (state.auth.accounts.some((account) => account.login.toLocaleLowerCase() === sender)) {
    return false;
  }
  const text = [messageText(message), message.systemMessage]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  return tab.mention.phrases.some((phrase) => text.includes(phrase.toLocaleLowerCase()));
}

/** Legacy listeners notify as before; custom listeners own the new switch. */
function listenerNotifies(tab: Tab): boolean {
  return tab.mention?.notify ?? true;
}

/** Whether this listener explicitly follows the message's author. */
function listenerWatchesSender(tab: Tab, message: ChatMessage): boolean {
  const sender = message.login.toLocaleLowerCase();
  return !!sender && !!tab.mention?.users?.some((user) => user.toLocaleLowerCase() === sender);
}

/** Whether one incoming message belongs in one mentions tab. */
function listenerMatches(
  state: Pick<ChatState, "auth" | "tabs">,
  tab: Tab,
  message: ChatMessage,
): boolean {
  if (tab.kind !== "mentions") return false;

  // A tab saved before custom listeners existed keeps its old behavior:
  // mentions/replies/whispers for its one account, from every open channel.
  if (!tab.mention) {
    if (message.account !== tab.account) return false;
    const hasSource = state.tabs.some(
      (source) =>
        source.kind === "channel" &&
        source.account === tab.account &&
        (message.kind === "whisper" || source.channel === message.channel),
    );
    return (
      hasSource &&
      (message.kind === "whisper" || isAboutYou(message, loginOf(state, tab.account)))
    );
  }

  if (message.kind === "notice") return false;
  if (!message.channel || !tab.mention.channels.includes(message.channel)) return false;
  if (!state.tabs.some((source) => source.kind === "channel" && source.channel === message.channel)) {
    return false;
  }
  const named = tab.mention.accounts.some((account) =>
    isAboutYou(message, loginOf(state, account)),
  );
  if (named) return true;

  if (listenerWatchesSender(tab, message)) return true;

  return listenerPhraseMatches(state, tab, message);
}

/** Whether a listener match respects the sound-specific notification toggles. */
function listenerWouldSound(state: ChatState, tab: Tab, message: StoredMessage): boolean {
  if (!tab.mention) {
    if (message.kind === "whisper") return true;
    const login = loginOf(state, tab.account);
    if (!isAboutYou(message, login)) return false;
    const kind = mentionKind(message, login);
    if (!kind) return true;
    return kind === "tag" ? state.preferences.notifyOnTag : state.preferences.notifyOnName;
  }

  if (listenerPhraseMatches(state, tab, message)) return true;
  if (listenerWatchesSender(tab, message)) return true;

  return tab.mention.accounts.some((account) => {
    const login = loginOf(state, account);
    if (!isAboutYou(message, login)) return false;
    const kind = mentionKind(message, login);
    // A reply is about the account without necessarily spelling its name.
    if (!kind) return true;
    return kind === "tag" ? state.preferences.notifyOnTag : state.preferences.notifyOnName;
  });
}

function unseenMentionMessages(
  existing: StoredMessage[],
  incoming: StoredMessage[],
): StoredMessage[] {
  const seen = new Set(existing.map(mentionIdentity));
  return incoming.filter((message) => {
    const identity = mentionIdentity(message);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Append without retaining duplicate copies delivered through two account sockets. */
function appendMentionMessages(
  existing: StoredMessage[],
  incoming: StoredMessage[],
): StoredMessage[] {
  let next = existing.concat(unseenMentionMessages(existing, incoming));
  if (next.length > MAX_MESSAGES + TRIM_SLACK) next = next.slice(next.length - MAX_MESSAGES);
  return next;
}

/** Existing live matches used only to seed a quick-created user listener. */
function heldListenerMessages(state: ChatState, tab: Tab): StoredMessage[] {
  const heard = (message: StoredMessage) =>
    !mentionIgnored(message, state.preferences.mentionIgnores) &&
    !userBlocked(message, state.preferences.blockedUsers);
  const matches = Object.values(state.messages)
    .flat()
    .filter(
      (message) => !message.historical && heard(message) && listenerMatches(state, tab, message),
    );
  return appendMentionMessages([], matches);
}

export type ListenerCloseWarning = {
  tabId: string;
  channel: string;
  listeners: string[];
};

/**
 * The profile picture a tab sends as, empty when it's anonymous, the account
 * has been signed out, or Twitch had no picture for it. The composer draws the
 * login's initial instead, so an empty string is a fallback rather than a gap.
 */
export function avatarOf(state: { auth: AuthStatus }, account: string | undefined): string {
  if (!account) return "";
  return state.auth.accounts.find((held) => held.id === account)?.avatarUrl ?? "";
}

/**
 * Each pane's active tab, corrected against the tabs it actually holds. Every
 * rearrangement runs through here rather than fixing `active` by hand: a tab
 * dragged across the divider, closed, or swept up by an unsplit leaves the
 * pane it was in pointing at something that isn't there any more.
 */
function settleActive(layout: Layout, preferred: (string | null)[]): [string | null, string | null] {
  const next: (string | null)[] = [preferred[0] ?? null, preferred[1] ?? null];
  for (const pane of PANES) {
    const tabs = paneTabs(layout, pane);
    if (next[pane] && tabs.some((tab) => tab.id === next[pane])) continue;
    next[pane] = tabs[0]?.id ?? null;
  }
  return next as [string | null, string | null];
}

export type ActiveModeration = {
  kind: "ban" | "timeout";
  /** Permanent for bans; wall-clock expiry for timeouts. */
  expiresAt: number | null;
};

const moderationKey = (channel: string, login: string) =>
  `${channel.toLocaleLowerCase()}\n${login.toLocaleLowerCase()}`;

/** A live ban/timeout learned from IRC, excluding timeouts that have expired. */
export function activeModeration(
  moderations: Record<string, ActiveModeration>,
  channel: string,
  login: string,
  now = Date.now(),
): ActiveModeration | undefined {
  const held = moderations[moderationKey(channel, login)];
  return held && (held.expiresAt === null || held.expiresAt > now) ? held : undefined;
}

type ChatState = {
  /** Every open tab, in bar order -- the backend's list, mirrored here. */
  tabs: Tab[];
  /**
   * The tab each pane is showing, by id. Both are "what you're reading" -- a
   * message arriving in either is one you can see, so neither counts as unread
   * -- but only `focusedPane` decides where a whisper is filed and what Ctrl+W
   * closes.
   */
  active: [string | null, string | null];
  /** The pane you last clicked in. Always `0` while unsplit. */
  focusedPane: PaneIndex;
  /**
   * Messages per tab, not per channel. The same channel open under two
   * accounts is two streams -- each socket receives its own copy -- and each
   * tab keeps what its own connection got.
   */
  messages: Record<string, StoredMessage[]>;
  unread: Record<string, number>;
  /** Of those unread messages, how many name you -- what reddens the badge. */
  mentions: Record<string, number>;
  /**
   * Who has talked in each tab, for the composer's `@` completion.
   * Session-only on purpose: Twitch has no "who's in this channel" for a plain
   * chat client, and a stale name is worse than a missing one when you're
   * trying to reply to someone.
   */
  chatters: Record<string, Chatters>;
  /** Everything the settings dialog edits, as stored in `settings.json`. */
  preferences: Preferences;
  /**
   * Whether a newer release is out, and how far a download has got. A whole
   * snapshot rather than a flag, because the settings dialog can be opened
   * mid-download and has to find what the events have already painted.
   */
  update: UpdateState;
  /** Whether each tab's own join has finished loading. */
  ready: Record<string, boolean>;
  /**
   * Channels currently broadcasting. Only known while some account is signed
   * in -- Helix has no anonymous way to ask -- so an absent entry means "not
   * known to be live", never a confident "offline". Keyed by channel: who's
   * live is a property of the room, not of the tab watching it.
   */
  live: Record<string, boolean>;
  /**
   * Each channel owner's profile picture, by channel -- what a tab draws
   * behind its name under `owner`. Keyed by channel because it belongs to the
   * room, and empty when signed out, since Get Users needs a token.
   */
  channelAvatars: Record<string, string>;
  /** Emote count per channel, for the composer's placeholder. */
  emoteCounts: Record<string, number>;
  /**
   * What you are in each tab, for the command picker. Absent means viewer --
   * either you are one, or the channel's USERSTATE hasn't arrived yet, and
   * offering too few commands beats offering ones Twitch will refuse. Per tab
   * because it's per account: one login can be a mod where another isn't.
   */
  roles: Record<string, ChannelRole>;
  /** Current bans/timeouts observed from IRC, keyed by channel and login. */
  moderations: Record<string, ActiveModeration>;
  /** Completable emotes per tab, sorted case-insensitively by name. */
  emoteEntries: Record<string, EmoteEntry[]>;
  /**
   * 7TV badges by Twitch user id. Kept here rather than on the message
   * because they land *after* the message that prompted the lookup, and a
   * stored message is immutable -- `MessageRow` subscribes to this instead.
   */
  seventvBadges: Record<string, Badge>;
  /** Matching live messages per mentions-tab id, newest last. */
  mentionLog: Record<string, StoredMessage[]>;
  /** A channel close waiting for the user to acknowledge stopped listeners. */
  listenerCloseWarning: ListenerCloseWarning | null;
  /** Send count per emote name, shared across channels and accounts. */
  emoteUses: Record<string, number>;
  /**
   * What you've sent in each tab, oldest first, for the composer's up/down
   * history. Per tab because what you said as one account in one channel has
   * no bearing on what you'd repeat as another.
   */
  sentHistory: Record<string, string[]>;
  /** Connection state per account id -- one socket each. */
  connections: Record<string, ConnectionState>;
  connectionDetail: string | null;
  auth: AuthStatus;
  globalEmotes: number;

  /**
   * Show a tab, in the pane that holds it -- and focus that pane, since that's
   * the one you just asked to read.
   */
  setActive: (id: string, pane?: PaneIndex) => void;
  /** Remember which pane you're working in. Clicking anywhere inside one does it. */
  focusPane: (pane: PaneIndex) => void;
  /**
   * Move a tab to `index` within `pane`'s tab list, across the divider or
   * within one bar. The index is read after the tab is lifted out, which is
   * what a drop onto a given tab means.
   */
  moveTab: (id: string, pane: PaneIndex, index: number) => void;
  /** Divide the window, putting the new empty pane first (left/top) or second. */
  split: (layout: Exclude<SplitLayout, "none">, newPaneFirst: boolean) => void;
  /** Turn an existing split from side-by-side to stacked, or back. */
  setSplitLayout: (layout: Exclude<SplitLayout, "none">) => void;
  /** Exchange the two panes, contents and sizes together. */
  swapPanes: () => void;
  /** Undo the split, gathering every tab back into one pane. */
  removeSplit: () => void;
  /** Where the divider sits, as the first pane's share of the split axis. */
  setSplitRatio: (ratio: number) => void;
  /**
   * Open a tab and switch to it. `account` defaults to the one new tabs are
   * set to use; the same channel under a *different* account is a new tab
   * rather than a duplicate, which is the point of the whole thing.
   */
  openTab: (kind: "channel", channel: string, account?: string) => Promise<void>;
  /** Create and persist a listener, optionally seeding its current matches. */
  openMentionsTab: (
    mention: MentionFilter,
    options?: { seedCurrentMatches?: boolean },
  ) => Promise<void>;
  /** Change a custom listener's visible name without replacing its log. */
  renameMentionsTab: (id: string, name: string) => Promise<void>;
  /** Enable or disable its mention sound and rose tab badge. */
  setMentionsTabNotify: (id: string, notify: boolean) => Promise<void>;
  /** Persist all editable listener settings for messages received from then on. */
  updateMentionsTab: (id: string, mention: MentionFilter) => Promise<void>;
  /** Close immediately, or open the listener warning when this is a source tab. */
  requestCloseTab: (id: string) => void;
  cancelListenerClose: () => void;
  confirmListenerClose: (dontShowAgain: boolean) => Promise<void>;
  /** Read (and send) as a different account, keeping the tab and its messages. */
  setTabAccount: (id: string, account: string) => Promise<void>;
  /** Change which picture one tab draws behind its name. */
  setTabAvatarMode: (id: string, mode: TabAvatarMode) => Promise<void>;
  sendMessage: (id: string, text: string, replyToId?: string, replyTo?: ReplyInfo) => Promise<void>;
  /**
   * Run a slash command and print what it reported into the tab. Throws on
   * failure, so the composer can keep your text and show why.
   */
  runCommand: (id: string, input: string) => Promise<void>;
  loadEmoteIndex: (id: string) => Promise<void>;
  refreshAuth: () => Promise<void>;
  setAuth: (auth: AuthStatus) => void;
  /** Merge a change into the preferences and persist the result. */
  updatePreferences: (patch: Partial<Preferences>) => void;
  /** Add a rule to one of the emote blacklists. A duplicate is a no-op. */
  addEmoteRule: (list: BlacklistKind, rule: EmoteRule) => void;
  /** Drop a rule from one of the emote blacklists. */
  removeEmoteRule: (list: BlacklistKind, rule: EmoteRule) => void;
  /** Add or drop a `@login`/`#channel` entry on the mention-ignore list. */
  setMentionIgnored: (entry: string, ignored: boolean) => void;
  /** Add or drop a login on the blocked list. */
  setUserBlocked: (login: string, blocked: boolean) => void;
  toggleMuted: () => void;
  toggleAlwaysOnTop: () => void;
  /** Re-read where the update machinery got to. Called when settings opens. */
  refreshUpdate: () => Promise<void>;
  /** Ask GitHub whether there's something newer. Downloads nothing. */
  checkForUpdate: () => Promise<void>;
  /** Fetch the update the last check found and put it in place. */
  installUpdate: () => Promise<void>;
  /** Restart into the version just installed. */
  restartForUpdate: () => Promise<void>;
  ingest: (batch: ChatMessage[]) => void;
  clear: (event: ClearEvent) => void;
  /** Forget a ban/timeout after Twitch accepts the matching unban command. */
  clearModeration: (channel: string, login: string) => void;
  bootstrap: () => Promise<void>;
};

/**
 * Bump the ranking counts for the emotes in a message we just sent. Emote
 * names are case-sensitive, so only words matching one exactly count -- and
 * only known emotes, which keeps ordinary words out of the persisted map.
 */
function noteEmoteUses(tab: Tab, text: string) {
  const state = useChat.getState();
  const entries = state.emoteEntries[tab.id];
  if (!entries?.length) return;

  const used = emotesIn(text, new Set(entries.map((entry) => entry.name)));
  if (used.length === 0) return;

  const emoteUses = { ...state.emoteUses };
  for (const name of used) emoteUses[name] = (emoteUses[name] ?? 0) + 1;
  useChat.setState({ emoteUses });
  if (IS_TAURI) void api.recordEmoteUses(tab.account, tab.channel, used);
}

/**
 * Append a sent message to its tab's history. Repeating yourself doesn't add
 * an entry -- walking back through a run of identical messages would just be
 * pressing up several times to get to the same text.
 */
function noteSent(id: string, text: string) {
  useChat.setState((state) => {
    const existing = state.sentHistory[id] ?? [];
    if (existing[existing.length - 1] === text) return {};
    const next = existing.concat(text);
    return {
      sentHistory: {
        ...state.sentHistory,
        [id]: next.length > MAX_SENT_HISTORY ? next.slice(next.length - MAX_SENT_HISTORY) : next,
      },
    };
  });
}

/**
 * Keep the newest `MAX_CHATTERS` entries. String keys hold insertion order, so
 * the ones to drop are simply the first ones listed.
 */
function trimChatters(chatters: Chatters): Chatters {
  const logins = Object.keys(chatters);
  if (logins.length <= MAX_CHATTERS) return chatters;
  const trimmed = { ...chatters };
  for (const login of logins.slice(0, logins.length - MAX_CHATTERS)) delete trimmed[login];
  return trimmed;
}

/**
 * Which tabs a message belongs in.
 *
 * Normally exactly one: a channel tab is unique in (channel, account), and the
 * backend stamps every message with the account whose socket received it. A
 * message with no channel of its own -- a whisper, or a notice from the socket
 * itself -- goes to the tab of that account you're reading, the same way a
 * whisper has always landed in front of you rather than nowhere.
 */
function targetsFor(state: ChatState, message: ChatMessage): string[] {
  if (message.channel) {
    return state.tabs
      .filter(
        (tab) =>
          tab.kind === "channel" &&
          tab.channel === message.channel &&
          tab.account === message.account,
      )
      .map((tab) => tab.id);
  }

  const mine = state.tabs.filter(
    (tab) => tab.kind === "channel" && tab.account === message.account,
  );
  const focused = state.active[state.focusedPane];
  const here = mine.find((tab) => tab.id === focused) ?? mine[0];
  return here ? [here.id] : [];
}

/**
 * Write a rearranged pair of tab lists back to the two places they came from:
 * the tab order (the backend's) and the boundary between the panes. Only what
 * actually changed is written, so an in-pane drag doesn't touch the split and a
 * drag across it doesn't rewrite an order that hasn't moved.
 */
function commitTabs(lists: [Tab[], Tab[]]) {
  const state = useChat.getState();
  const split = state.preferences.splitLayout !== "none";
  const tabs = split ? lists[0].concat(lists[1]) : lists[0];

  if (tabs.length !== state.tabs.length || tabs.some((tab, at) => tab.id !== state.tabs[at]?.id)) {
    useChat.setState({ tabs });
    if (IS_TAURI) void api.reorderTabs(tabs.map((tab) => tab.id));
  }
  if (split && lists[0].length !== state.preferences.splitIndex) {
    useChat.getState().updatePreferences({ splitIndex: lists[0].length });
  }
}

/**
 * Put a freshly opened tab in the pane you were working in, and show it. The
 * backend appends it, which is the *second* pane's end, so opening one from the
 * first is a move back across the divider.
 */
function placeNewTab(id: string) {
  const state = useChat.getState();
  if (state.preferences.splitLayout !== "none" && state.focusedPane === 0) {
    const lists: [Tab[], Tab[]] = [paneTabs(state, 0), paneTabs(state, 1)];
    const at = lists[1].findIndex((tab) => tab.id === id);
    if (at >= 0) {
      lists[0].push(lists[1].splice(at, 1)[0]);
      commitTabs(lists);
    }
  }
  useChat.getState().setActive(id);
}

/**
 * What a tab opening now draws behind its name. Mirrors `stamped_avatar_mode`
 * in Rust, which is what stamps the real thing -- this is for mock mode, where
 * tabs are minted in the browser and never reach a backend.
 */
function stampAvatarMode(state: ChatState, account: string): TabAvatarMode {
  const mode = state.preferences.newTabAvatarMode;
  if (mode !== "otherAccount") return mode;
  return account === state.auth.defaultAccount ? "none" : "account";
}

/** Everything kept about one tab and nothing else, dropped when it closes. */
function forgetTab(state: ChatState, id: string) {
  const drop = <T,>(map: Record<string, T>) => {
    const next = { ...map };
    delete next[id];
    return next;
  };
  return {
    messages: drop(state.messages),
    unread: drop(state.unread),
    mentions: drop(state.mentions),
    chatters: drop(state.chatters),
    ready: drop(state.ready),
    roles: drop(state.roles),
    emoteEntries: drop(state.emoteEntries),
    sentHistory: drop(state.sentHistory),
    mentionLog: drop(state.mentionLog),
  };
}

/** Which listeners would lose this channel source if its tab were closed. */
function listenersStoppedByClosing(state: ChatState, closing: Tab): string[] {
  if (closing.kind !== "channel") return [];

  return state.tabs
    .filter((tab) => tab.kind === "mentions")
    .filter((tab) => {
      if (tab.mention) {
        if (!tab.mention.channels.includes(closing.channel)) return false;
        return !state.tabs.some(
          (other) =>
            other.id !== closing.id &&
            other.kind === "channel" &&
            other.channel === closing.channel,
        );
      }

      // A legacy listener consumes only the copy received by its one account,
      // so another account's tab on the room does not keep it fed.
      if (tab.account !== closing.account) return false;
      return !state.tabs.some(
        (other) =>
          other.id !== closing.id &&
          other.kind === "channel" &&
          other.channel === closing.channel &&
          other.account === closing.account,
      );
    })
    .map(mentionTabName);
}

/** The one unguarded close operation; only the request/confirmation flow calls it. */
async function closeTabNow(id: string) {
  const tabs = IS_TAURI
    ? await api.closeTab(id)
    : useChat.getState().tabs.filter((tab) => tab.id !== id);

  useChat.setState((state) => ({
    tabs,
    listenerCloseWarning: null,
    ...forgetTab(state, id),
  }));
  const settled = useChat.getState();
  useChat.setState({ active: settleActive(settled, settled.active) });
}

export const useChat = create<ChatState>((set) => ({
  tabs: [],
  active: [null, null],
  focusedPane: 0,
  messages: {},
  unread: {},
  mentions: {},
  chatters: {},
  preferences: DEFAULT_PREFERENCES,
  update: IDLE_UPDATE,
  ready: {},
  live: {},
  channelAvatars: {},
  emoteCounts: {},
  roles: {},
  moderations: {},
  emoteEntries: {},
  seventvBadges: {},
  mentionLog: {},
  listenerCloseWarning: null,
  emoteUses: {},
  sentHistory: {},
  connections: {},
  connectionDetail: null,
  auth: {
    hasClientId: false,
    clientIdOverride: null,
    accounts: [],
    defaultAccount: ANONYMOUS,
    permissionGroups: [],
    permissionCatalog: [],
  },
  globalEmotes: 0,

  setActive: (id, pane) =>
    set((state) => {
      const target = pane ?? paneOf(state, id) ?? state.focusedPane;
      const active = state.active.slice() as [string | null, string | null];
      active[target] = id;
      return {
        active,
        focusedPane: target,
        unread: { ...state.unread, [id]: 0 },
        mentions: { ...state.mentions, [id]: 0 },
      };
    }),

  focusPane: (pane) =>
    set((state) => {
      if (state.focusedPane === pane || state.preferences.splitLayout === "none") return {};
      // Reading a pane clears what you hadn't looked at in it, the same way
      // clicking its tab does -- the messages are in front of you either way.
      const id = state.active[pane];
      if (!id) return { focusedPane: pane };
      return {
        focusedPane: pane,
        unread: { ...state.unread, [id]: 0 },
        mentions: { ...state.mentions, [id]: 0 },
      };
    }),

  moveTab: (id, pane, index) => {
    const state = useChat.getState();
    const lists: [Tab[], Tab[]] = [paneTabs(state, 0), paneTabs(state, 1)];
    const from = PANES.find((candidate) => lists[candidate].some((tab) => tab.id === id));
    if (from === undefined) return;
    const [moved] = lists[from].splice(
      lists[from].findIndex((tab) => tab.id === id),
      1,
    );
    // The index is into the list with the tab already lifted out, which is
    // what dropping *onto* a tab means: it takes that tab's place.
    lists[pane].splice(Math.max(0, Math.min(index, lists[pane].length)), 0, moved);
    commitTabs(lists);

    const settled = useChat.getState();
    if (from === pane) return;
    // Dragging a tab into the other pane is asking to read it there, so it
    // arrives shown and focused; the pane it left falls back to a neighbour.
    const preferred = settled.active.slice();
    preferred[pane] = id;
    preferred[from] = settled.active[from] === id ? null : settled.active[from];
    set({ active: settleActive(settled, preferred), focusedPane: pane });
  },

  split: (layout, newPaneFirst) => {
    const state = useChat.getState();
    state.updatePreferences({
      splitLayout: layout,
      // Everything open stays together in the pane that isn't the new one.
      splitIndex: newPaneFirst ? 0 : state.tabs.length,
    });
    const pane: PaneIndex = newPaneFirst ? 0 : 1;
    const preferred: (string | null)[] = [null, null];
    // Whatever was on screen is still on screen, in the other pane.
    preferred[pane === 0 ? 1 : 0] = state.active[state.focusedPane];
    const settled = useChat.getState();
    // The empty pane takes the focus: splitting is how you make room for
    // something, so Ctrl+K and the add button should fill the new half.
    set({ active: settleActive(settled, preferred), focusedPane: pane });
  },

  setSplitLayout: (layout) => useChat.getState().updatePreferences({ splitLayout: layout }),

  swapPanes: () => {
    const state = useChat.getState();
    if (state.preferences.splitLayout === "none") return;
    commitTabs([paneTabs(state, 1), paneTabs(state, 0)]);
    // The divider moves with the contents: a pane that was wide stays wide
    // around the tabs it was made wide for.
    useChat
      .getState()
      .updatePreferences({ splitRatio: clampRatio(1 - state.preferences.splitRatio) });
    const settled = useChat.getState();
    set({
      active: settleActive(settled, [state.active[1], state.active[0]]),
      focusedPane: state.focusedPane === 0 ? 1 : 0,
    });
  },

  removeSplit: () => {
    const state = useChat.getState();
    if (state.preferences.splitLayout === "none") return;
    state.updatePreferences({ splitLayout: "none" });
    const settled = useChat.getState();
    set({
      // You keep reading what you were reading; the other pane's tab is still
      // in the bar, one click away.
      active: settleActive(settled, [state.active[state.focusedPane], null]),
      focusedPane: 0,
    });
  },

  setSplitRatio: (ratio) => useChat.getState().updatePreferences({ splitRatio: clampRatio(ratio) }),

  openTab: async (kind, channel, account) => {
    const state = useChat.getState();
    const name = channel.trim().replace(/^[#@]/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(name)) {
      throw new Error(`"${channel}" is not a valid Twitch channel name`);
    }

    const tab: Tab = {
      id: newTabId(),
      kind,
      channel: name,
      account: account ?? state.auth.defaultAccount,
      avatarMode: "none",
      mention: null,
    };
    // Stamped once, here, exactly as `add_tab` does it in Rust: the preference
    // is a rule for new tabs, not something a tab keeps re-reading.
    tab.avatarMode = stampAvatarMode(state, tab.account);

    // The same channel twice as the same account would be two identical views
    // of one stream. Switch to the one already open instead.
    const existing = state.tabs.find(
      (open) =>
        open.kind === tab.kind && open.channel === tab.channel && open.account === tab.account,
    );
    if (existing) {
      useChat.getState().setActive(existing.id);
      return;
    }

    const tabs = IS_TAURI ? await api.addTab(tab) : [...state.tabs, tab];
    set((current) => ({
      tabs,
      // Nothing to wait for without a backend, so mock tabs open ready.
      ...(IS_TAURI ? {} : { ready: { ...current.ready, [tab.id]: true } }),
    }));
    // The backend has the last word on whether it opened -- it refuses the
    // duplicates this checked for a moment ago, and something else could have
    // opened one in between. Showing a tab that isn't there would leave the
    // pane pointing at nothing.
    if (!tabs.some((open) => open.id === tab.id)) {
      const settled = useChat.getState();
      set({ active: settleActive(settled, settled.active) });
      return;
    }
    placeNewTab(tab.id);
  },

  openMentionsTab: async (mention, options) => {
    const state = useChat.getState();
    const listener: MentionFilter = {
      ...mention,
      name: mention.name.trim(),
      accounts: [...mention.accounts],
      users: mention.users.map((user) => user.trim().replace(/^@/, "").toLocaleLowerCase()),
      channels: [...mention.channels],
      phrases: mention.phrases.map((phrase) => phrase.trim()).filter(Boolean),
    };
    const tab: Tab = {
      id: newTabId(),
      kind: "mentions",
      channel: "",
      account: listener.accounts[0] ?? ANONYMOUS,
      avatarMode: "none",
      mention: listener,
    };

    const tabs = IS_TAURI ? await api.addTab(tab) : [...state.tabs, tab];
    const opened = tabs.find((candidate) => candidate.id === tab.id);
    if (!opened) {
      set({ tabs });
      return;
    }
    set((current) => ({
      tabs,
      // General listeners start at creation time. The chatter-name shortcut
      // opts into seeding that user's messages already held in its channel.
      mentionLog: {
        ...current.mentionLog,
        [opened.id]: options?.seedCurrentMatches
          ? heldListenerMessages(current, opened)
          : [],
      },
    }));
    placeNewTab(opened.id);
  },

  renameMentionsTab: async (id, name) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    const clean = name.trim();
    if (!tab?.mention || !clean || clean.length > 40 || tab.mention.name === clean) return;

    set({
      tabs: IS_TAURI
        ? await api.renameMentionsTab(id, clean)
        : state.tabs.map((open) =>
            open.id === id && open.mention
              ? { ...open, mention: { ...open.mention, name: clean } }
              : open,
          ),
    });
  },

  setMentionsTabNotify: async (id, notify) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab?.mention || tab.mention.notify === notify) return;

    const tabs = IS_TAURI
      ? await api.setMentionsTabNotify(id, notify)
      : state.tabs.map((open) =>
          open.id === id && open.mention
            ? { ...open, mention: { ...open.mention, notify } }
            : open,
        );
    set((current) => ({
      tabs,
      // Turning notifications off should remove an existing rose indication
      // immediately; the ordinary unread tally is deliberately untouched.
      ...(notify ? {} : { mentions: { ...current.mentions, [id]: 0 } }),
    }));
  },

  updateMentionsTab: async (id, mention) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab?.mention) return;

    const tabs = IS_TAURI
      ? await api.updateMentionsTab(id, mention)
      : state.tabs.map((open) =>
          open.id === id
            ? { ...open, account: mention.accounts[0] ?? ANONYMOUS, mention }
            : open,
        );
    const updated = tabs.find((open) => open.id === id);
    if (!updated?.mention) return;
    const notificationsEnabled = updated.mention.notify;

    set((current) => ({
      tabs,
      // Existing rows record what matched while the previous definition was
      // active. Editing a filter only changes which future messages append.
      ...(notificationsEnabled
        ? {}
        : { mentions: { ...current.mentions, [id]: 0 } }),
    }));
  },

  requestCloseTab: (id) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab) return;
    const listeners = state.preferences.warnOnListenerClose
      ? listenersStoppedByClosing(state, tab)
      : [];
    if (listeners.length > 0) {
      set({ listenerCloseWarning: { tabId: id, channel: tab.channel, listeners } });
      return;
    }
    void closeTabNow(id);
  },

  cancelListenerClose: () => set({ listenerCloseWarning: null }),

  confirmListenerClose: async (dontShowAgain) => {
    const state = useChat.getState();
    const pending = state.listenerCloseWarning;
    if (!pending) return;
    if (dontShowAgain) state.updatePreferences({ warnOnListenerClose: false });
    set({ listenerCloseWarning: null });
    await closeTabNow(pending.tabId);
  },

  setTabAvatarMode: async (id, mode) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab || tab.avatarMode === mode) return;

    set({
      tabs: IS_TAURI
        ? await api.setTabAvatarMode(id, mode)
        : state.tabs.map((open) => (open.id === id ? { ...open, avatarMode: mode } : open)),
    });
  },

  setTabAccount: async (id, account) => {
    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab || tab.account === account) return;

    const tabs = IS_TAURI
      ? await api.setTabAccount(id, account)
      : state.tabs.map((open) => (open.id === id ? { ...open, account } : open));

    set({ tabs });
    // Refused, because that account already has this channel open -- the tab
    // is untouched, and so is everything hanging off it.
    if (tabs.find((open) => open.id === id)?.account !== account) return;

    // The messages already here were said in this channel and are just as true
    // read as anyone, so they stay. What doesn't: which of Twitch's emotes are
    // completable, and what this login may do in this room -- both belonged to
    // the account that just left.
    set({
      roles: { ...state.roles, [id]: "viewer" },
      emoteEntries: { ...state.emoteEntries, [id]: [] },
      ready: { ...state.ready, [id]: !IS_TAURI },
    });
    void useChat.getState().loadEmoteIndex(id);
  },

  sendMessage: async (id, text, replyToId, replyTo) => {
    const tab = tabById(useChat.getState(), id);
    if (!tab) return;

    if (MOCK_MODE) {
      const { buildOwnMockMessage } = await import("../dev/mockData");
      const login = loginOf(useChat.getState(), tab.account) ?? "you";
      useChat.getState().ingest([buildOwnMockMessage(tab, login, text, replyTo)]);
      noteEmoteUses(tab, text);
      noteSent(id, text);
      return;
    }
    await api.sendMessage(tab.account, tab.channel, text, replyToId);
    // Only after Twitch accepts it: a message that never went out shouldn't
    // reshuffle the completion order, and a rejected one stays in the composer
    // rather than becoming a history entry you'd have to walk back to.
    noteEmoteUses(tab, text);
    noteSent(id, text);
  },

  /**
   * Twitch stopped taking chat commands over IRC in 2023, so each one is a
   * Helix call the backend makes -- as this tab's account, whose token decides
   * what it may do -- except `/help`, which is answered from the catalog the
   * picker already has and never leaves the app.
   */
  runCommand: async (id, input) => {
    const parsed = splitCommand(input);
    if (!parsed) throw new Error("That isn't a command");

    const state = useChat.getState();
    const tab = tabById(state, id);
    if (!tab) return;

    let lines: string[];
    if (parsed.name === "help") {
      lines = helpLines(parsed.args, state.auth, tab.account);
    } else if (!MOCK_MODE) {
      lines = [await api.runChatCommand(tab.account, tab.channel, input)];
    } else {
      const mock = await import("../dev/mockData");
      lines = [mock.mockCommandResult(input)];
    }

    state.ingest(lines.map((line) => localNotice(tab, line)));
    // Only once it worked, and for the same reason a sent message is: a
    // command that was refused stays in the composer to be fixed, and
    // shouldn't also be sitting one up-arrow away.
    noteSent(id, input);
  },

  /**
   * Pull a tab's completable emotes. Cheap to repeat -- it's re-run when the
   * tab finishes loading, which also covers signing in and changing the tab's
   * account, since Twitch's own emotes belong to the token that asked.
   */
  loadEmoteIndex: async (id) => {
    const tab = tabById(useChat.getState(), id);
    if (!tab || tab.kind !== "channel") return;
    const index = MOCK_MODE
      ? await import("../dev/mockData").then((mock) => mock.mockEmoteIndex())
      : await api.emoteIndex(tab.account, tab.channel);
    set((state) => ({
      emoteEntries: { ...state.emoteEntries, [id]: index.entries },
      // Counts are global, and the backend's copy is the persisted one.
      emoteUses: index.uses,
    }));
  },

  refreshAuth: async () => set({ auth: await api.authStatus() }),

  /**
   * Roles belong to a token, so an account going away drops what it could do.
   * The tabs it was reading stay open and fall back to anonymous -- which the
   * backend has already done to its own list by the time this lands.
   */
  setAuth: (auth) =>
    set((state) => {
      const held = new Set(auth.accounts.map((account) => account.id));
      const roles = { ...state.roles };
      for (const tab of state.tabs) {
        if (tab.account !== ANONYMOUS && !held.has(tab.account)) delete roles[tab.id];
      }
      const tabs = state.tabs.map((tab) => ({
        ...tab,
        account: tab.account && !held.has(tab.account) ? ANONYMOUS : tab.account,
        mention: tab.mention
          ? {
              ...tab.mention,
              accounts: tab.mention.accounts.filter((account) => held.has(account)),
            }
          : null,
      }));
      return { auth, roles, tabs };
    }),

  updatePreferences: (patch) => {
    const preferences = normalize({ ...useChat.getState().preferences, ...patch });
    // Applied optimistically -- the dialog's controls should feel instant, and
    // there's nothing to roll back to if the write fails.
    set({ preferences });
    if (IS_TAURI) void api.setPreferences(preferences);
    else writeMockPreferences(preferences);
  },

  addEmoteRule: (list, rule) =>
    useChat.getState().updatePreferences({
      [list]: withRule(useChat.getState().preferences[list], rule),
    }),

  removeEmoteRule: (list, rule) =>
    useChat.getState().updatePreferences({
      [list]: withoutRule(useChat.getState().preferences[list], rule),
    }),

  setMentionIgnored: (entry, ignored) => {
    const list = useChat.getState().preferences.mentionIgnores;
    useChat.getState().updatePreferences({
      mentionIgnores: ignored ? withEntry(list, entry) : withoutEntry(list, entry),
    });
  },

  setUserBlocked: (login, blocked) => {
    const name = login.toLowerCase();
    const list = useChat.getState().preferences.blockedUsers;
    useChat.getState().updatePreferences({
      blockedUsers: blocked ? withEntry(list, name) : withoutEntry(list, name),
    });
  },

  toggleMuted: () =>
    useChat.getState().updatePreferences({ muted: !useChat.getState().preferences.muted }),

  toggleAlwaysOnTop: () =>
    useChat
      .getState()
      .updatePreferences({ alwaysOnTop: !useChat.getState().preferences.alwaysOnTop }),

  refreshUpdate: async () => {
    const update = MOCK_MODE
      ? await import("../dev/mockUpdates").then((mock) => mock.mockUpdateState())
      : await api.updateState();
    // Only the resting stages: a `refreshUpdate` racing a download in mock
    // mode would otherwise snap the bar back to nothing.
    set((state) => (state.update.stage === "downloading" ? {} : { update }));
  },

  checkForUpdate: async () => {
    set((state) => ({ update: { ...state.update, stage: "checking", error: null } }));
    const update = MOCK_MODE
      ? await import("../dev/mockUpdates").then((mock) => mock.mockCheck())
      : await api.checkForUpdates();
    set({ update });
  },

  installUpdate: async () => {
    if (MOCK_MODE) {
      const { mockInstall } = await import("../dev/mockUpdates");
      await mockInstall((update) => set({ update }));
      return;
    }
    // Rust drives the states from here: progress rides `update://state`, and
    // on Windows this call never comes back at all -- the installer takes the
    // process with it. A rejection has already been rendered as `failed`.
    await api.installUpdate().catch(() => {});
  },

  restartForUpdate: async () => {
    if (MOCK_MODE) {
      console.info("mock: restarting");
      set({ update: IDLE_UPDATE });
      return;
    }
    await api.restartApp();
  },

  ingest: (batch) => {
    if (batch.length === 0) return;

    // Set inside the update below, played after it: the ping belongs to the
    // batch as a whole, and one sound per batch is what keeps a spammed name
    // from turning into a machine gun. Notification preferences are read in
    // there too, from the same snapshot the messages are filed against.
    let mentioned = false;

    set((state) => {
      // Keyed once, up front: a message that lands in both its tab and a
      // mentions tab is the same object in both, so a row shown in each is one
      // memoized component rather than two that happen to look alike.
      const stamped: StoredMessage[] = batch.map((message) => ({ ...message, key: nextKey++ }));

      // Group by tab so each tab's array is rebuilt once per batch.
      const grouped = new Map<string, StoredMessage[]>();
      for (const message of stamped) {
        for (const id of targetsFor(state, message)) {
          const list = grouped.get(id) ?? [];
          list.push(message);
          grouped.set(id, list);
        }
      }

      const { mentionIgnores, blockedUsers } = state.preferences;
      /**
       * Whether this message is allowed to be a mention at all. Blocking
       * someone implies ignoring them: a message that isn't drawn shouldn't
       * still be ringing a bell somewhere.
       */
      const heard = (message: StoredMessage) =>
        !mentionIgnored(message, mentionIgnores) && !userBlocked(message, blockedUsers);

      const messages = { ...state.messages };
      const unread = { ...state.unread };
      const mentions = { ...state.mentions };
      const chatters = { ...state.chatters };

      for (const [id, incoming] of grouped) {
        const tab = tabById(state, id);
        const login = loginOf(state, tab?.account);

        // A tab's chatter map is only rebuilt when someone new speaks -- which
        // is rare after the first minute, and a busy channel would otherwise
        // copy the whole map on every batch.
        let seen = chatters[id];
        let added = false;
        for (const message of incoming) {
          const who = message.login.toLowerCase();
          // A whisper's sender isn't in the channel it landed in, so they
          // don't belong in its `@` completion.
          if (!who || message.kind === "notice" || message.kind === "whisper") continue;
          if (who === login?.toLowerCase()) continue;
          if (seen?.[who]) continue;
          seen = { ...(seen ?? {}), [who]: message.displayName || message.login };
          added = true;
        }
        if (added && seen) chatters[id] = trimChatters(seen);

        const existing = messages[id] ?? [];
        let next = existing.concat(incoming);
        if (next.length > MAX_MESSAGES + TRIM_SLACK) {
          next = next.slice(next.length - MAX_MESSAGES);
        }
        messages[id] = next;

        // A backlog replayed on join isn't news. It renders, and its chatters
        // count for `@` completion, but nothing about it is an event: no ping,
        // no unread, no reddened tab.
        const fresh = incoming.filter((message) => !message.historical);

        const { notifyOnTag, notifyOnName, notifyActiveTab, muted } = state.preferences;
        // Either pane counts as looking at it: a message you can see land
        // isn't news, whichever half of the window it landed in.
        const watching = state.active.includes(id);
        // A whisper always pings, unlike a mention in the channel you're
        // already reading: it arrived from outside the room, so there's no
        // reason to assume you were watching for it. Muting still silences it.
        if (!muted && fresh.some((message) => message.kind === "whisper" && heard(message))) {
          mentioned = true;
        }
        // The tab you're looking at stays silent unless you ask for it: you
        // can already see the mention land.
        const audible = !muted && (!watching || notifyActiveTab);
        const naming = fresh.filter((message) => {
          if (!heard(message)) return false;
          const kind = mentionKind(message, login);
          if (!kind) return false;
          // The badge and the highlight count every mention; only the sound
          // asks whether you wanted to hear about this kind of one.
          if (audible && (kind === "tag" ? notifyOnTag : notifyOnName)) mentioned = true;
          return true;
        });

        // Counted like unread is, and for the same reason: it's a tally of
        // what you haven't looked at, so the tab you're reading has none.
        if (!watching && fresh.length > 0) {
          unread[id] = (unread[id] ?? 0) + fresh.length;
          if (naming.length > 0) {
            mentions[id] = (mentions[id] ?? 0) + naming.length;
          }
        }
      }

      // Each mentions tab owns its own log and filter. A listener never opens
      // a channel: it can only match copies delivered through channel tabs
      // that are already open.
      const mentionLog = { ...state.mentionLog };
      for (const tab of state.tabs) {
        if (tab.kind !== "mentions") continue;
        const existing = mentionLog[tab.id] ?? [];
        const matching = stamped.filter(
          (message) =>
            !message.historical && heard(message) && listenerMatches(state, tab, message),
        );
        const addressed = unseenMentionMessages(existing, matching);
        if (addressed.length === 0) continue;

        mentionLog[tab.id] = appendMentionMessages(existing, addressed);

        // Unread counts every unseen match. The rose mention counter is the
        // listener's optional notification indication, so it moves only when
        // that listener has notifications enabled.
        if (!state.active.includes(tab.id)) {
          unread[tab.id] = (unread[tab.id] ?? 0) + addressed.length;
          if (listenerNotifies(tab)) {
            mentions[tab.id] = (mentions[tab.id] ?? 0) + addressed.length;
          }
        }

        const sourceVisible = addressed.some((message) =>
          state.active.some((id) => {
            const activeTab = tabById(state, id);
            return activeTab?.kind === "channel" && activeTab.channel === message.channel;
          }),
        );
        const watching = state.active.includes(tab.id) || sourceVisible;
        if (
          listenerNotifies(tab) &&
          !state.preferences.muted &&
          (!watching || state.preferences.notifyActiveTab) &&
          addressed.some((message) => listenerWouldSound(state, tab, message))
        ) {
          mentioned = true;
        }
      }

      return { messages, unread, mentions, chatters, mentionLog };
    });

    // Global mute and mention-kind toggles only take the sound. A listener's
    // own notification switch also gates its rose badge, while its ordinary
    // unread count and highlighted rows remain.
    if (mentioned) playMentionSound();
  },

  clear: ({ account, channel, login, messageId, duration }) => {
    set((state) => {
      const normalizedLogin = login?.toLocaleLowerCase() ?? "";
      const hit = (message: StoredMessage) => messageCleared(message, messageId, login);
      const strike = (message: StoredMessage) =>
        hit(message) ? { ...message, deleted: true } : message;

      // Every tab on this channel *as this account*: a deletion is a fact
      // about the room, but it arrives on one socket, and the other account's
      // copy of the same message is a different object with its own key.
      const messages = { ...state.messages };
      for (const tab of state.tabs) {
        if (tab.kind !== "channel" || tab.channel !== channel || tab.account !== account) continue;
        const existing = messages[tab.id];
        if (existing) messages[tab.id] = existing.map(strike);
      }

      // Every matching listener holds a reference to one of the account
      // copies. A room deletion applies to them all, regardless of which
      // account's socket delivered the moderation event.
      const mentionLog = { ...state.mentionLog };
      for (const [id, log] of Object.entries(mentionLog)) {
        mentionLog[id] = log.map((message) =>
          message.channel === channel ? strike(message) : message,
        );
      }

      const moderations = { ...state.moderations };
      if (normalizedLogin) {
        moderations[moderationKey(channel, normalizedLogin)] = {
          kind: duration == null ? "ban" : "timeout",
          expiresAt: duration == null ? null : Date.now() + duration * 1_000,
        };
      }

      return { messages, mentionLog, moderations };
    });
  },

  clearModeration: (channel, login) =>
    set((state) => {
      const key = moderationKey(channel, login);
      if (!(key in state.moderations)) return {};
      const moderations = { ...state.moderations };
      delete moderations[key];
      return { moderations };
    }),

  bootstrap: async () => {
    if (MOCK_MODE) {
      const {
        mockTabs,
        buildInitialMessages,
        mockAuthStatus,
        mockSevenTvBadges,
        MOCK_CHANNEL_AVATARS,
      } = await import("../dev/mockData");
      const { mockUpdateState } = await import("../dev/mockUpdates");
      const preferences = readMockPreferences();
      const tabs = mockTabs();
      set({
        tabs,
        auth: mockAuthStatus(),
        active: settleActive({ tabs, preferences }, [null, null]),
        ready: Object.fromEntries(tabs.map((tab) => [tab.id, true])),
        emoteCounts: Object.fromEntries(tabs.map((tab) => [tab.channel, 886])),
        live: { [tabs[0].channel]: true },
        channelAvatars: MOCK_CHANNEL_AVATARS,
        // One tab of each, so the command picker's filtering is visible.
        roles: { [tabs[0].id]: "moderator", [tabs[1].id]: "broadcaster" },
        connections: Object.fromEntries(tabs.map((tab) => [tab.account, "connected" as const])),
        globalEmotes: 45,
        seventvBadges: mockSevenTvBadges(),
        preferences,
        update: mockUpdateState(),
      });
      useChat.getState().ingest(buildInitialMessages(tabs));
      return;
    }

    const [tabs, auth, preferences, channelAvatars, live, update] = await Promise.all([
      api.listTabs(),
      api.authStatus(),
      api.preferences(),
      api.channelAvatars(),
      api.liveChannels(),
      api.updateState(),
    ]);
    const settings = normalize(preferences);
    set((state) => ({
      tabs,
      auth,
      preferences: settings,
      update,
      channelAvatars,
      live: Object.fromEntries(live.map((login) => [login, true])),
      // Each pane opens on its own first tab.
      active: settleActive({ tabs, preferences: settings }, state.active),
    }));
  },
}));

/**
 * Wire backend events into the store. Call once at startup.
 *
 * In a plain browser (no Tauri) this drives a synthetic message stream
 * instead of subscribing to real IPC events, so tab unread counts, scroll
 * pinning and the "jump to present" pill are all exercisable while iterating
 * on design with `npm run dev`.
 */
export async function subscribeToBackend(): Promise<() => void> {
  if (MOCK_MODE) {
    const { randomMockMessage } = await import("../dev/mockData");
    const interval = window.setInterval(() => {
      const tabs = useChat.getState().tabs.filter((tab) => tab.kind === "channel");
      if (tabs.length === 0) return;
      const tab = tabs[Math.floor(Math.random() * tabs.length)];
      useChat.getState().ingest([randomMockMessage(tab)]);
    }, 1400);
    return () => window.clearInterval(interval);
  }

  const unlisteners = await Promise.all([
    listen<ChatMessage[]>("chat://messages", (event) => {
      useChat.getState().ingest(event.payload);
    }),

    // One socket per account, so this says whose. A closed one is dropped
    // rather than remembered as disconnected: it isn't down, it's gone.
    listen<StatusEvent>("chat://status", (event) => {
      const { account, state, detail } = event.payload;
      useChat.setState((current) => {
        const connections = { ...current.connections };
        if (state === "closed") delete connections[account];
        else connections[account] = state;
        return { connections, connectionDetail: detail };
      });
    }),

    listen<ClearEvent>("chat://clear", (event) => {
      useChat.getState().clear(event.payload);
    }),

    listen<ChannelReadyEvent>("chat://channel-ready", (event) => {
      const { account, channel, emoteCount } = event.payload;
      const state = useChat.getState();
      const ready = { ...state.ready };
      const ids: string[] = [];
      for (const tab of state.tabs) {
        if (tab.kind !== "channel" || tab.channel !== channel || tab.account !== account) continue;
        ready[tab.id] = true;
        ids.push(tab.id);
      }
      useChat.setState({ ready, emoteCounts: { ...state.emoteCounts, [channel]: emoteCount } });
      for (const id of ids) void useChat.getState().loadEmoteIndex(id);
    }),

    // The set behind an open channel moved -- 7TV pushes those. The notice
    // saying so arrives as an ordinary message; this is the other half, the
    // completion index and the count catching up with what can now be typed.
    listen<EmoteSetEvent>("chat://emote-set", (event) => {
      const { channel, emoteCount } = event.payload;
      const state = useChat.getState();
      useChat.setState({ emoteCounts: { ...state.emoteCounts, [channel]: emoteCount } });
      for (const tab of state.tabs) {
        if (tab.kind === "channel" && tab.channel === channel) {
          void useChat.getState().loadEmoteIndex(tab.id);
        }
      }
    }),

    listen<Record<string, Badge>>("chat://seventv-badges", (event) => {
      useChat.setState((state) => ({
        seventvBadges: { ...state.seventvBadges, ...event.payload },
      }));
    }),

    listen<{ globalEmotes: number }>("chat://assets", (event) => {
      useChat.setState({ globalEmotes: event.payload.globalEmotes });
      // Global assets can land after a tab is already ready, so any index
      // built before this is missing Twitch's global emotes -- rebuild them.
      const state = useChat.getState();
      for (const id of Object.keys(state.emoteEntries)) {
        void state.loadEmoteIndex(id);
      }
    }),

    // Sent on join and whenever it changes -- see `ChannelRole` in the parser.
    listen<RoleEvent>("chat://role", (event) => {
      const { account, channel, moderator, broadcaster } = event.payload;
      useChat.setState((state) => {
        const roles = { ...state.roles };
        for (const tab of state.tabs) {
          if (tab.kind !== "channel" || tab.channel !== channel || tab.account !== account) {
            continue;
          }
          roles[tab.id] = broadcaster ? "broadcaster" : moderator ? "moderator" : "viewer";
        }
        return { roles };
      });
    }),

    listen<AuthStatus>("chat://auth", (event) => {
      useChat.getState().setAuth(event.payload);
    }),

    // Sent whole rather than as deltas, and only when the set actually
    // changes, so replacing the map wholesale is both correct and cheap.
    listen<string[]>("chat://live", (event) => {
      useChat.setState({
        live: Object.fromEntries(event.payload.map((login) => [login, true])),
      });
    }),
    // The whole map every time, not a delta: it only grows, and it's one
    // short string per open channel.
    // Not a `chat://` event: this one is about the app, not a channel. Rust
    // drives every stage, so the store only ever mirrors what it's told.
    listen<UpdateState>("update://state", (event) => {
      useChat.setState({ update: event.payload });
    }),
    listen<Record<string, string>>("chat://channel-avatars", (event) => {
      useChat.setState({ channelAvatars: event.payload });
    }),
  ]);

  return () => unlisteners.forEach((off) => off());
}
