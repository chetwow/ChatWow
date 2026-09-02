import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { IS_TAURI } from "../lib/tauri";
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
import { ANONYMOUS } from "../types";
import type {
  AuthStatus,
  Badge,
  ChannelRole,
  RoleEvent,
  EmoteRule,
  Preferences,
  EmoteEntry,
  ChannelReadyEvent,
  ChatMessage,
  ClearEvent,
  ConnectionState,
  PaneIndex,
  ReplyInfo,
  NewTabAvatarMode,
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
  showMessageHistory: true,
  enableSeventv: true,
  enableBttv: true,
  enableFfz: true,
  showSeventvBadges: true,
  italicActions: true,
  showTimestamps: true,
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

/**
 * The worst state any connection is in, which is what the title bar's dot
 * shows. One socket per account means several answers to "are we connected",
 * and the one that's down is the one worth showing; with nothing open at all
 * there's no bad news to report.
 */
export function connectionState(state: {
  connections: Record<string, ConnectionState>;
}): ConnectionState {
  const states = Object.values(state.connections);
  if (states.length === 0) return "connected";
  for (const wanted of ["disconnected", "reconnecting", "connecting"] as const) {
    if (states.includes(wanted)) return wanted;
  }
  return "connected";
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
  /** Completable emotes per tab, sorted case-insensitively by name. */
  emoteEntries: Record<string, EmoteEntry[]>;
  /**
   * 7TV badges by Twitch user id. Kept here rather than on the message
   * because they land *after* the message that prompted the lookup, and a
   * stored message is immutable -- `MessageRow` subscribes to this instead.
   */
  seventvBadges: Record<string, Badge>;
  /**
   * Everything addressed to each account, from every channel, newest last --
   * what that account's mentions tab renders. Per account because a mention is
   * addressed to a login: what names one of yours names only that one.
   *
   * Kept whether or not a mentions tab is open, so opening one isn't opening
   * an empty pane. Replayed backlog never lands here -- it would arrive
   * stamped with times older than what's already in the list.
   */
  mentionLog: Record<string, StoredMessage[]>;
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
  openTab: (kind: Tab["kind"], channel: string, account?: string) => Promise<void>;
  /** Close a tab, and forget everything that was only ever about that view. */
  closeTab: (id: string) => Promise<void>;
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
  ingest: (batch: ChatMessage[]) => void;
  clear: (event: ClearEvent) => void;
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
  };
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
  ready: {},
  live: {},
  channelAvatars: {},
  emoteCounts: {},
  roles: {},
  emoteEntries: {},
  seventvBadges: {},
  mentionLog: {},
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
    if (kind === "channel" && !/^[a-z0-9_]{3,25}$/.test(name)) {
      throw new Error(`"${channel}" is not a valid Twitch channel name`);
    }

    const tab: Tab = {
      id: newTabId(),
      kind,
      channel: kind === "mentions" ? "" : name,
      account: account ?? state.auth.defaultAccount,
      avatarMode: "none",
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

  closeTab: async (id) => {
    const tabs = IS_TAURI
      ? await api.closeTab(id)
      : useChat.getState().tabs.filter((tab) => tab.id !== id);

    set((state) => ({ tabs, ...forgetTab(state, id) }));
    const settled = useChat.getState();
    set({ active: settleActive(settled, settled.active) });
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

    if (!IS_TAURI) {
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
    } else if (IS_TAURI) {
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
    const index = IS_TAURI
      ? await api.emoteIndex(tab.account, tab.channel)
      : await import("../dev/mockData").then((mock) => mock.mockEmoteIndex());
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
      return { auth, roles };
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

      // The mentions logs, taken from the whole batch in one pass rather than
      // per tab -- they span every channel by definition, and they're per
      // account because what names one of your logins names only that one.
      const mentionLog = { ...state.mentionLog };
      const byAccount = new Map<string, StoredMessage[]>();
      for (const message of stamped) {
        if (message.historical || !heard(message)) continue;
        const login = loginOf(state, message.account);
        // A whisper qualifies without being read: it was sent to this account
        // and to nobody else.
        if (message.kind !== "whisper" && !isAboutYou(message, login)) continue;
        const list = byAccount.get(message.account) ?? [];
        list.push(message);
        byAccount.set(message.account, list);
      }

      for (const [account, addressed] of byAccount) {
        let log = (mentionLog[account] ?? []).concat(addressed);
        if (log.length > MAX_MESSAGES + TRIM_SLACK) {
          log = log.slice(log.length - MAX_MESSAGES);
        }
        mentionLog[account] = log;

        // Counted the way a channel tab is: a tally of what you haven't looked
        // at. Everything in here names you, so its badge is always the rose
        // one -- both counters move together.
        for (const tab of state.tabs) {
          if (tab.kind !== "mentions" || tab.account !== account) continue;
          if (state.active.includes(tab.id)) continue;
          unread[tab.id] = (unread[tab.id] ?? 0) + addressed.length;
          mentions[tab.id] = (mentions[tab.id] ?? 0) + addressed.length;
        }
      }

      return { messages, unread, mentions, chatters, mentionLog };
    });

    // Muting, and the toggles above, only take the sound -- the highlight and
    // the badge are the quiet half of a mention and always happen.
    if (mentioned) playMentionSound();
  },

  clear: ({ account, channel, login, messageId }) => {
    set((state) => {
      const hit = (message: StoredMessage) =>
        messageId ? message.id === messageId : login ? message.login === login : false;
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

      // The mentions log holds its own reference to the same messages, so a
      // deletion has to reach both -- otherwise a timed-out mention stays
      // standing in the one place you'd go looking for it.
      const mentionLog = { ...state.mentionLog };
      const log = mentionLog[account];
      if (log) {
        mentionLog[account] = log.map((message) =>
          message.channel === channel ? strike(message) : message,
        );
      }

      return { messages, mentionLog };
    });
  },

  bootstrap: async () => {
    if (!IS_TAURI) {
      const {
        mockTabs,
        buildInitialMessages,
        mockAuthStatus,
        mockSevenTvBadges,
        MOCK_CHANNEL_AVATARS,
      } = await import("../dev/mockData");
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
      });
      useChat.getState().ingest(buildInitialMessages(tabs));
      return;
    }

    const [tabs, auth, preferences, channelAvatars] = await Promise.all([
      api.listTabs(),
      api.authStatus(),
      api.preferences(),
      api.channelAvatars(),
    ]);
    const settings = normalize(preferences);
    set((state) => ({
      tabs,
      auth,
      preferences: settings,
      channelAvatars,
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
  if (!IS_TAURI) {
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
    listen<Record<string, string>>("chat://channel-avatars", (event) => {
      useChat.setState({ channelAvatars: event.payload });
    }),
  ]);

  return () => unlisteners.forEach((off) => off());
}
