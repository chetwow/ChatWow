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
  SplitLayout,
  StatusEvent,
  StoredMessage,
} from "../types";

/**
 * The one tab that isn't a channel: everything from every channel that names
 * you, replies to you, or was whispered to you. `@` is illegal in a Twitch
 * login, so this key can never collide with a real channel -- which is what
 * lets it share `active`, `unread` and `mentions` with them and behave like an
 * ordinary tab everywhere those are read.
 *
 * It is deliberately *not* in `channels`: that list is the backend's, and a
 * name in it would be a channel to join, part and reorder.
 */
export const MENTIONS_TAB = "@mentions";

/** Per-channel backlog cap. Beyond this the oldest messages are dropped. */
const MAX_MESSAGES = 500;
/** Trim in chunks so we're not reallocating the array on every single message. */
const TRIM_SLACK = 100;
/** How many of your own sent messages the up-arrow can walk back through. */
const MAX_SENT_HISTORY = 100;
/** Per-channel cap on remembered chatters, oldest dropped first. */
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
  previewImages: true,
  previewYoutube: true,
  previewTwitch: true,
  previewPages: true,
  singleRowTabs: true,
  mentionsTab: false,
  mentionsTabIndex: 0,
  mentionsPane: 0,
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
  if (!Number.isInteger(merged.mentionsTabIndex) || merged.mentionsTabIndex < 0) {
    merged.mentionsTabIndex = DEFAULT_PREFERENCES.mentionsTabIndex;
  }
  if (merged.mentionsPane !== 0 && merged.mentionsPane !== 1) {
    merged.mentionsPane = DEFAULT_PREFERENCES.mentionsPane;
  }
  if (!SPLIT_LAYOUTS.has(merged.splitLayout)) merged.splitLayout = DEFAULT_PREFERENCES.splitLayout;
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

/** The pieces the pane layout is derived from, and all it needs to be derived. */
type Layout = { channels: string[]; preferences: Preferences };

/**
 * The channels in one pane, in bar order. `splitIndex` is the boundary in the
 * one `channels` list rather than a second list of its own: that list is the
 * backend's record of what's joined and in what order, and keeping the split
 * as a position in it means dragging a tab across the divider is an ordinary
 * move within it -- nothing can end up in both panes, or in neither.
 *
 * Unsplit, everything is in the first pane and the second is empty.
 */
export function paneChannels(layout: Layout, pane: PaneIndex): string[] {
  if (layout.preferences.splitLayout === "none") return pane === 0 ? layout.channels : [];
  const at = Math.min(layout.preferences.splitIndex, layout.channels.length);
  return pane === 0 ? layout.channels.slice(0, at) : layout.channels.slice(at);
}

/**
 * Every tab in one pane: its channels, with the mentions tab dropped in
 * wherever it was left if this is the pane holding it. An index past the end
 * lands it last, which is what a parted channel or a hand-edited settings file
 * leaves behind.
 */
export function paneTabs(layout: Layout, pane: PaneIndex): string[] {
  const list = paneChannels(layout, pane);
  const { mentionsTab, mentionsTabIndex, mentionsPane, splitLayout } = layout.preferences;
  // Unsplit there's only one pane to be in, whatever the preference last said.
  const home = splitLayout === "none" ? 0 : mentionsPane;
  if (!mentionsTab || home !== pane) return list;
  const next = list.slice();
  next.splice(Math.min(mentionsTabIndex, list.length), 0, MENTIONS_TAB);
  return next;
}

/** Which pane a tab is in, or `null` for one that isn't open anywhere. */
export function paneOf(layout: Layout, tab: string): PaneIndex | null {
  for (const pane of PANES) if (paneTabs(layout, pane).includes(tab)) return pane;
  return null;
}

/**
 * Each pane's active tab, corrected against the tabs it actually holds. Every
 * rearrangement runs through here rather than fixing `active` by hand: a tab
 * dragged across the divider, parted, or swept up by an unsplit leaves the
 * pane it was in pointing at something that isn't there any more.
 */
function settleActive(layout: Layout, preferred: (string | null)[]): [string | null, string | null] {
  const next: (string | null)[] = [preferred[0] ?? null, preferred[1] ?? null];
  for (const pane of PANES) {
    const tabs = paneTabs(layout, pane);
    if (next[pane] && tabs.includes(next[pane]!)) continue;
    next[pane] = tabs[0] ?? null;
  }
  return next as [string | null, string | null];
}

type ChatState = {
  channels: string[];
  /**
   * The tab each pane is showing, indexed by `PaneIndex`. Both are "what
   * you're reading" -- a message arriving in either is one you can see, so
   * neither counts as unread -- but only `focusedPane` decides where a
   * whisper is filed and what Ctrl+W closes.
   */
  active: [string | null, string | null];
  /** The pane you last clicked in. Always `0` while unsplit. */
  focusedPane: PaneIndex;
  messages: Record<string, StoredMessage[]>;
  unread: Record<string, number>;
  /** Of those unread messages, how many name you -- what reddens the badge. */
  mentions: Record<string, number>;
  /**
   * Who has talked in each channel since launch, for the composer's `@`
   * completion. Session-only on purpose: Twitch has no "who's in this
   * channel" for a plain chat client, and a stale name is worse than a
   * missing one when you're trying to reply to someone.
   */
  chatters: Record<string, Chatters>;
  /** Everything the settings dialog edits, as stored in `settings.json`. */
  preferences: Preferences;
  ready: Record<string, boolean>;
  /**
   * Channels currently broadcasting. Only known while signed in -- Helix has no
   * anonymous way to ask -- so an absent entry means "not known to be live",
   * never a confident "offline".
   */
  live: Record<string, boolean>;
  /**
   * What you are in each channel, for the command picker. Absent means viewer
   * -- either you are one, or the channel's USERSTATE hasn't arrived yet, and
   * offering too few commands beats offering ones Twitch will refuse.
   */
  roles: Record<string, ChannelRole>;
  emoteCounts: Record<string, number>;
  /** Completable emotes per channel, sorted case-insensitively by name. */
  emoteEntries: Record<string, EmoteEntry[]>;
  /**
   * 7TV badges by Twitch user id. Kept here rather than on the message
   * because they land *after* the message that prompted the lookup, and a
   * stored message is immutable -- `MessageRow` subscribes to this instead.
   */
  seventvBadges: Record<string, Badge>;
  /**
   * Everything that was addressed to you, from every channel, newest last --
   * what the mentions tab renders. Kept whether or not that tab is open, so
   * opening it isn't opening an empty pane; a message arrives here as the same
   * object its channel holds, so a row shown in both is one memoized component
   * rather than two that happen to look alike.
   *
   * Replayed backlog never lands here. It would arrive stamped with times
   * older than what's already in the list, so a channel joined at noon would
   * file this morning's mentions below this minute's.
   */
  mentionLog: StoredMessage[];
  /** Send count per emote name, shared across channels. */
  emoteUses: Record<string, number>;
  /**
   * What you've sent in each channel, oldest first, for the composer's
   * up/down history. Kept per channel because what you say in one has no
   * bearing on what you'd repeat in another.
   */
  sentHistory: Record<string, string[]>;
  connection: ConnectionState;
  connectionDetail: string | null;
  auth: AuthStatus;
  globalEmotes: number;

  /**
   * Show a tab, in the pane that holds it -- and focus that pane, since
   * that's the one you just asked to read. An unopened channel (a name
   * clicked in the mentions tab) opens in the focused pane.
   */
  setActive: (channel: string, pane?: PaneIndex) => void;
  /** Remember which pane you're working in. Clicking anywhere inside one does it. */
  focusPane: (pane: PaneIndex) => void;
  /**
   * Move a tab to `index` within `pane`'s tab list, across the divider or
   * within one bar. The index is read after the tab is lifted out, which is
   * what a drop onto a given tab means.
   */
  moveTab: (tab: string, pane: PaneIndex, index: number) => void;
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
  join: (channel: string) => Promise<void>;
  part: (channel: string) => Promise<void>;
  reorderChannels: (channels: string[]) => void;
  sendMessage: (channel: string, text: string, replyToId?: string, replyTo?: ReplyInfo) => Promise<void>;
  /**
   * Run a slash command and print what it reported into the channel. Throws
   * on failure, so the composer can keep your text and show why.
   */
  runCommand: (channel: string, input: string) => Promise<void>;
  loadEmoteIndex: (channel: string) => Promise<void>;
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
  /** Open the mentions tab and switch to it. Already open: just switch. */
  openMentionsTab: () => void;
  ingest: (batch: ChatMessage[]) => void;
  clear: (event: ClearEvent) => void;
  bootstrap: () => Promise<void>;
};

/**
 * Bump the ranking counts for the emotes in a message we just sent. Emote
 * names are case-sensitive, so only words matching one exactly count -- and
 * only known emotes, which keeps ordinary words out of the persisted map.
 */
function noteEmoteUses(channel: string, text: string) {
  const state = useChat.getState();
  const entries = state.emoteEntries[channel];
  if (!entries?.length) return;

  const used = emotesIn(text, new Set(entries.map((entry) => entry.name)));
  if (used.length === 0) return;

  const emoteUses = { ...state.emoteUses };
  for (const name of used) emoteUses[name] = (emoteUses[name] ?? 0) + 1;
  useChat.setState({ emoteUses });
  if (IS_TAURI) void api.recordEmoteUses(channel, used);
}

/**
 * Append a sent message to its channel's history. Repeating yourself doesn't
 * add an entry -- walking back through a run of identical messages would just
 * be pressing up several times to get to the same text.
 */
function noteSent(channel: string, text: string) {
  useChat.setState((state) => {
    const existing = state.sentHistory[channel] ?? [];
    if (existing[existing.length - 1] === text) return {};
    const next = existing.concat(text);
    return {
      sentHistory: {
        ...state.sentHistory,
        [channel]: next.length > MAX_SENT_HISTORY ? next.slice(next.length - MAX_SENT_HISTORY) : next,
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
 * Write a rearranged pair of tab lists back to the three places they came
 * from: the channel order (the backend's), the boundary between the panes,
 * and the mentions tab's home and index. Only what actually changed is
 * written, so an in-pane drag doesn't touch the split and a drag across it
 * doesn't rewrite an order that hasn't moved.
 */
function commitTabs(lists: [string[], string[]]) {
  const state = useChat.getState();
  const split = state.preferences.splitLayout !== "none";
  const channelLists = lists.map((list) => list.filter((tab) => tab !== MENTIONS_TAB));
  const channels = split ? channelLists[0].concat(channelLists[1]) : channelLists[0];
  if (
    channels.length !== state.channels.length ||
    channels.some((name, index) => name !== state.channels[index])
  ) {
    state.reorderChannels(channels);
  }

  const patch: Partial<Preferences> = {};
  if (split && channelLists[0].length !== state.preferences.splitIndex) {
    patch.splitIndex = channelLists[0].length;
  }
  const home: PaneIndex = lists[1].includes(MENTIONS_TAB) ? 1 : 0;
  const at = lists[home].indexOf(MENTIONS_TAB);
  if (at >= 0) {
    if (split && home !== state.preferences.mentionsPane) patch.mentionsPane = home;
    if (at !== state.preferences.mentionsTabIndex) patch.mentionsTabIndex = at;
  }
  if (Object.keys(patch).length > 0) state.updatePreferences(patch);
}

/**
 * Put a freshly joined channel in the pane you were working in. The backend
 * appends it to `channels`, which is the *second* pane's end, so joining from
 * the first one is a move back across the divider. Either way the panes are
 * settled afterwards: a pane that was empty is now showing its first tab.
 */
function placeJoined(name: string, before: string[]) {
  const state = useChat.getState();
  if (!name || before.includes(name)) return;
  if (state.preferences.splitLayout !== "none" && state.focusedPane === 0) {
    const lists: [string[], string[]] = [paneTabs(state, 0), paneTabs(state, 1)];
    lists[1].splice(lists[1].indexOf(name), 1);
    lists[0].push(name);
    commitTabs(lists);
  }
  const settled = useChat.getState();
  useChat.setState({ active: settleActive(settled, settled.active) });
}

export const useChat = create<ChatState>((set) => ({
  channels: [],
  active: [null, null],
  focusedPane: 0,
  messages: {},
  unread: {},
  mentions: {},
  chatters: {},
  preferences: DEFAULT_PREFERENCES,
  ready: {},
  live: {},
  roles: {},
  emoteCounts: {},
  emoteEntries: {},
  seventvBadges: {},
  mentionLog: [],
  emoteUses: {},
  sentHistory: {},
  connection: "connecting",
  connectionDetail: null,
  auth: {
    hasClientId: false,
    clientIdOverride: null,
    loggedIn: false,
    login: null,
    scopes: [],
    permissionGroups: [],
    permissionCatalog: [],
  },
  globalEmotes: 0,

  setActive: (channel, pane) =>
    set((state) => {
      const target = pane ?? paneOf(state, channel) ?? state.focusedPane;
      const active = state.active.slice() as [string | null, string | null];
      active[target] = channel;
      return {
        active,
        focusedPane: target,
        unread: { ...state.unread, [channel]: 0 },
        mentions: { ...state.mentions, [channel]: 0 },
      };
    }),

  focusPane: (pane) =>
    set((state) => {
      if (state.focusedPane === pane || state.preferences.splitLayout === "none") return {};
      // Reading a pane clears what you hadn't looked at in it, the same way
      // clicking its tab does -- the messages are in front of you either way.
      const channel = state.active[pane];
      if (!channel) return { focusedPane: pane };
      return {
        focusedPane: pane,
        unread: { ...state.unread, [channel]: 0 },
        mentions: { ...state.mentions, [channel]: 0 },
      };
    }),

  moveTab: (tab, pane, index) => {
    const state = useChat.getState();
    const lists: [string[], string[]] = [paneTabs(state, 0), paneTabs(state, 1)];
    const from = PANES.find((candidate) => lists[candidate].includes(tab));
    if (from === undefined) return;
    lists[from].splice(lists[from].indexOf(tab), 1);
    // The index is into the list with the tab already lifted out, which is
    // what dropping *onto* a tab means: it takes that tab's place.
    lists[pane].splice(Math.max(0, Math.min(index, lists[pane].length)), 0, tab);
    commitTabs(lists);

    const settled = useChat.getState();
    if (from === pane) return;
    // Dragging a tab into the other pane is asking to read it there, so it
    // arrives shown and focused; the pane it left falls back to a neighbour.
    const preferred = settled.active.slice();
    preferred[pane] = tab;
    preferred[from] = settled.active[from] === tab ? null : settled.active[from];
    set({ active: settleActive(settled, preferred), focusedPane: pane });
  },

  split: (layout, newPaneFirst) => {
    const state = useChat.getState();
    state.updatePreferences({
      splitLayout: layout,
      // Everything joined stays together in the pane that isn't the new one.
      splitIndex: newPaneFirst ? 0 : state.channels.length,
      mentionsPane: newPaneFirst ? 1 : 0,
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
    const lists: [string[], string[]] = [paneTabs(state, 1), paneTabs(state, 0)];
    commitTabs(lists);
    // The divider moves with the contents: a pane that was wide stays wide
    // around the tabs it was made wide for.
    useChat.getState().updatePreferences({ splitRatio: clampRatio(1 - state.preferences.splitRatio) });
    const settled = useChat.getState();
    set({
      active: settleActive(settled, [state.active[1], state.active[0]]),
      focusedPane: state.focusedPane === 0 ? 1 : 0,
    });
  },

  removeSplit: () => {
    const state = useChat.getState();
    if (state.preferences.splitLayout === "none") return;
    // The merged bar is the two in order, so the mentions tab keeps its place
    // relative to the tabs around it rather than jumping back to where it sat
    // before the window was ever split.
    const merged = paneTabs(state, 0).concat(paneTabs(state, 1));
    const at = merged.indexOf(MENTIONS_TAB);
    state.updatePreferences({
      splitLayout: "none",
      mentionsPane: 0,
      ...(at >= 0 ? { mentionsTabIndex: at } : {}),
    });
    const settled = useChat.getState();
    set({
      // You keep reading what you were reading; the other pane's tab is still
      // in the bar, one click away.
      active: settleActive(settled, [state.active[state.focusedPane], null]),
      focusedPane: 0,
    });
  },

  setSplitRatio: (ratio) => useChat.getState().updatePreferences({ splitRatio: clampRatio(ratio) }),

  join: async (channel) => {
    const before = useChat.getState().channels;
    if (!IS_TAURI) {
      const name = channel.trim().replace(/^[#@]/, "").toLowerCase();
      if (!/^[a-z0-9_]{3,25}$/.test(name)) {
        throw new Error(`"${channel}" is not a valid Twitch channel name`);
      }
      if (before.includes(name)) return;
      set((state) => ({
        channels: [...state.channels, name],
        ready: { ...state.ready, [name]: true },
      }));
      placeJoined(name, before);
      return;
    }

    const channels = await api.joinChannel(channel);
    set({ channels });
    placeJoined(channels[channels.length - 1], before);
  },

  part: async (channel) => {
    // Closing the mentions tab isn't leaving anything -- it's the one tab with
    // no channel behind it. Routed through here so the tab's X and Ctrl+W
    // reach it the same way they reach a real tab.
    if (channel === MENTIONS_TAB) {
      useChat.getState().updatePreferences({ mentionsTab: false });
      const settled = useChat.getState();
      set({ active: settleActive(settled, settled.active) });
      return;
    }

    const name = IS_TAURI ? channel : channel.trim().replace(/^[#@]/, "").toLowerCase();
    // Before the channel goes: which side of the divider it was on decides
    // whether the boundary has to come back by one to stay pointing between
    // the same two tabs.
    const leaving = paneOf(useChat.getState(), name);

    const channels = IS_TAURI
      ? await api.partChannel(channel)
      : useChat.getState().channels.filter((c) => c !== name);

    set((state) => {
      const messages = { ...state.messages };
      const sentHistory = { ...state.sentHistory };
      const mentions = { ...state.mentions };
      const chatters = { ...state.chatters };
      delete messages[name];
      delete sentHistory[name];
      delete mentions[name];
      delete chatters[name];
      return { channels, messages, sentHistory, mentions, chatters };
    });

    const { preferences } = useChat.getState();
    if (leaving === 0 && preferences.splitLayout !== "none") {
      useChat.getState().updatePreferences({
        splitIndex: Math.max(0, Math.min(preferences.splitIndex - 1, channels.length)),
      });
    }
    const settled = useChat.getState();
    set({ active: settleActive(settled, settled.active) });
  },

  // Applied optimistically (the tab bar is already showing the dragged
  // order) -- for a real backend, fire the persist call without waiting on it.
  reorderChannels: (channels) => {
    set({ channels });
    if (IS_TAURI) void api.reorderChannels(channels);
  },

  sendMessage: async (channel, text, replyToId, replyTo) => {
    if (!IS_TAURI) {
      const { buildOwnMockMessage } = await import("../dev/mockData");
      useChat.getState().ingest([buildOwnMockMessage(channel, text, replyTo)]);
      noteEmoteUses(channel, text);
      noteSent(channel, text);
      return;
    }
    await api.sendMessage(channel, text, replyToId);
    // Only after Twitch accepts it: a message that never went out shouldn't
    // reshuffle the completion order, and a rejected one stays in the composer
    // rather than becoming a history entry you'd have to walk back to.
    noteEmoteUses(channel, text);
    noteSent(channel, text);
  },

  /**
   * Twitch stopped taking chat commands over IRC in 2023, so each one is a
   * Helix call the backend makes -- except `/help`, which is answered from the
   * catalog the picker already has and never leaves the app.
   */
  runCommand: async (channel, input) => {
    const parsed = splitCommand(input);
    if (!parsed) throw new Error("That isn't a command");

    const state = useChat.getState();
    let lines: string[];
    if (parsed.name === "help") {
      lines = helpLines(parsed.args, state.auth);
    } else if (IS_TAURI) {
      lines = [await api.runChatCommand(channel, input)];
    } else {
      const mock = await import("../dev/mockData");
      lines = [mock.mockCommandResult(input)];
    }

    state.ingest(lines.map((line) => localNotice(channel, line)));
    // Only once it worked, and for the same reason a sent message is: a
    // command that was refused stays in the composer to be fixed, and
    // shouldn't also be sitting one up-arrow away.
    noteSent(channel, input);
  },

  /**
   * Pull the channel's completable emotes. Cheap to repeat -- it's re-run when
   * a channel finishes loading, which also covers signing in, since Twitch's
   * own emotes only become fetchable once there's a token.
   */
  loadEmoteIndex: async (channel) => {
    const index = IS_TAURI
      ? await api.emoteIndex(channel)
      : await import("../dev/mockData").then((mock) => mock.mockEmoteIndex());
    set((state) => ({
      emoteEntries: { ...state.emoteEntries, [channel]: index.entries },
      // Counts are global, and the backend's copy is the persisted one.
      emoteUses: index.uses,
    }));
  },

  refreshAuth: async () => set({ auth: await api.authStatus() }),
  // Roles belong to the signed-in user, so signing out drops them rather than
  // leaving the last account's moderator commands on offer.
  setAuth: (auth) => set(auth.loggedIn ? { auth } : { auth, roles: {} }),

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

  openMentionsTab: () => {
    const state = useChat.getState();
    useChat.getState().updatePreferences({
      mentionsTab: true,
      // Where joining a channel would have put it, in the pane you're working
      // in. Only on the way in: a tab reopened after being dragged somewhere
      // should come back where it was, but the first time it has no
      // remembered place.
      ...(state.preferences.mentionsTab
        ? {}
        : {
            mentionsPane: state.focusedPane,
            mentionsTabIndex: paneChannels(state, state.focusedPane).length,
          }),
    });
    const { mentionsPane, splitLayout } = useChat.getState().preferences;
    useChat.getState().setActive(MENTIONS_TAB, splitLayout === "none" ? 0 : mentionsPane);
  },

  ingest: (batch) => {
    if (batch.length === 0) return;

    // Set inside the update below, played after it: the ping belongs to the
    // batch as a whole, and one sound per batch is what keeps a spammed name
    // from turning into a machine gun. Notification preferences are read in
    // there too, from the same snapshot the messages are filed against.
    let mentioned = false;

    set((state) => {
      // A whisper belongs to no channel -- Twitch delivers it outside chat --
      // so it goes wherever you're reading. With nothing open there's no view
      // to put it in, and it's dropped rather than filed under "".
      const routed = batch.flatMap((message) => {
        if (message.kind !== "whisper") return [message];
        const reading = state.active[state.focusedPane] ?? state.active.find(Boolean);
        return reading ? [{ ...message, channel: reading }] : [];
      });

      // Keyed once, up front: a message that lands in both its channel and the
      // mentions tab is the same object in both, so a row shown in each is one
      // memoized component rather than two that happen to look alike.
      const stamped: StoredMessage[] = routed.map((message) => ({ ...message, key: nextKey++ }));

      // Group by channel so each channel's array is rebuilt once per batch.
      const grouped = new Map<string, StoredMessage[]>();
      for (const message of stamped) {
        const list = grouped.get(message.channel) ?? [];
        list.push(message);
        grouped.set(message.channel, list);
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

      for (const [channel, incoming] of grouped) {
        // A channel's chatter map is only rebuilt when someone new speaks --
        // which is rare after the first minute, and a busy channel would
        // otherwise copy the whole map on every batch.
        let seen = chatters[channel];
        let added = false;
        for (const message of incoming) {
          const login = message.login.toLowerCase();
          // A whisper's sender isn't in the channel it landed in, so they
          // don't belong in its `@` completion.
          if (!login || message.kind === "notice" || message.kind === "whisper") continue;
          if (login === state.auth.login?.toLowerCase()) continue;
          if (seen?.[login]) continue;
          seen = { ...(seen ?? {}), [login]: message.displayName || message.login };
          added = true;
        }
        if (added && seen) chatters[channel] = trimChatters(seen);

        const existing = messages[channel] ?? [];
        let next = existing.concat(incoming);
        if (next.length > MAX_MESSAGES + TRIM_SLACK) {
          next = next.slice(next.length - MAX_MESSAGES);
        }
        messages[channel] = next;

        // A backlog replayed on join isn't news. It renders, and its chatters
        // count for `@` completion, but nothing about it is an event: no ping,
        // no unread, no reddened tab.
        const fresh = incoming.filter((message) => !message.historical);

        const { notifyOnTag, notifyOnName, notifyActiveTab, muted } = state.preferences;
        // A whisper always pings, unlike a mention in the channel you're
        // already reading: it arrived from outside the room, so there's no
        // reason to assume you were watching for it. Muting still silences it.
        if (!muted && fresh.some((message) => message.kind === "whisper" && heard(message))) {
          mentioned = true;
        }
        // The channel you're looking at stays silent unless you ask for it:
        // you can already see the mention land.
        // Either pane counts as looking at it: a message you can see land
        // isn't news, whichever half of the window it landed in.
        const watching = state.active.includes(channel);
        const audible = !muted && (!watching || notifyActiveTab);
        const naming = fresh.filter((message) => {
          if (!heard(message)) return false;
          const kind = mentionKind(message, state.auth.login);
          if (!kind) return false;
          // The badge and the highlight count every mention; only the sound
          // asks whether you wanted to hear about this kind of one.
          if (audible && (kind === "tag" ? notifyOnTag : notifyOnName)) mentioned = true;
          return true;
        });

        // Counted like unread is, and for the same reason: it's a tally of
        // what you haven't looked at, so the channel you're reading has none.
        if (!watching && fresh.length > 0) {
          unread[channel] = (unread[channel] ?? 0) + fresh.length;
          if (naming.length > 0) {
            mentions[channel] = (mentions[channel] ?? 0) + naming.length;
          }
        }
      }

      // The mentions tab, taken from the whole batch in one pass rather than
      // per channel -- it spans all of them by definition. A whisper qualifies
      // without being read: it was sent to you and to nobody else.
      const addressed = stamped.filter(
        (message) =>
          !message.historical &&
          heard(message) &&
          (message.kind === "whisper" || isAboutYou(message, state.auth.login)),
      );

      let mentionLog = state.mentionLog;
      if (addressed.length > 0) {
        mentionLog = mentionLog.concat(addressed);
        if (mentionLog.length > MAX_MESSAGES + TRIM_SLACK) {
          mentionLog = mentionLog.slice(mentionLog.length - MAX_MESSAGES);
        }
        // Counted the way a channel's tab is: a tally of what you haven't
        // looked at. Everything in here names you, so its badge is always the
        // rose one -- both counters move together.
        if (!state.active.includes(MENTIONS_TAB)) {
          unread[MENTIONS_TAB] = (unread[MENTIONS_TAB] ?? 0) + addressed.length;
          mentions[MENTIONS_TAB] = (mentions[MENTIONS_TAB] ?? 0) + addressed.length;
        }
      }

      return { messages, unread, mentions, chatters, mentionLog };
    });

    // Muting, and the toggles above, only take the sound -- the highlight and
    // the badge are the quiet half of a mention and always happen.
    if (mentioned) playMentionSound();
  },

  clear: ({ channel, login, messageId }) => {
    set((state) => {
      const existing = state.messages[channel];
      if (!existing) return {};

      const hit = (message: StoredMessage) =>
        messageId ? message.id === messageId : login ? message.login === login : false;
      const strike = (message: StoredMessage) =>
        hit(message) ? { ...message, deleted: true } : message;

      // The mentions tab holds its own reference to the same messages, so a
      // deletion has to reach both -- otherwise a timed-out mention stays
      // standing in the one place you'd go looking for it.
      return {
        messages: { ...state.messages, [channel]: existing.map(strike) },
        mentionLog: state.mentionLog.map((message) =>
          message.channel === channel ? strike(message) : message,
        ),
      };
    });
  },

  bootstrap: async () => {
    if (!IS_TAURI) {
      const { MOCK_CHANNELS, buildInitialMessages, mockAuthStatus, mockSevenTvBadges } =
        await import("../dev/mockData");
      const preferences = readMockPreferences();
      set({
        channels: MOCK_CHANNELS,
        active: settleActive({ channels: MOCK_CHANNELS, preferences }, [null, null]),
        ready: Object.fromEntries(MOCK_CHANNELS.map((c) => [c, true])),
        emoteCounts: Object.fromEntries(MOCK_CHANNELS.map((c) => [c, 886])),
        live: { [MOCK_CHANNELS[0]]: true, [MOCK_CHANNELS[2]]: true },
        // One channel of each, so the picker's filtering is visible in mock.
        roles: {
          [MOCK_CHANNELS[0]]: "moderator",
          [MOCK_CHANNELS[1]]: "broadcaster",
          [MOCK_CHANNELS[2]]: "viewer",
        },
        connection: "connected",
        globalEmotes: 45,
        // `login` is set (despite `loggedIn: false`, matching real signed-out
        // state everywhere else) so the "replying to you" highlight has an
        // identity to match against during design iteration.
        auth: mockAuthStatus(),
        seventvBadges: mockSevenTvBadges(),
        preferences,
      });
      useChat.getState().ingest(buildInitialMessages());
      return;
    }

    const [channels, auth, preferences] = await Promise.all([
      api.listChannels(),
      api.authStatus(),
      api.preferences(),
    ]);
    const settings = normalize(preferences);
    set((state) => ({
      channels,
      auth,
      preferences: settings,
      // Each pane opens on its own first tab -- which, with no channels but a
      // mentions tab, is that tab: it's the whole app then, and it should open
      // on it rather than on the join-a-channel screen behind it.
      active: settleActive({ channels, preferences: settings }, state.active),
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
export async function subscribeToBackend() {
  if (!IS_TAURI) {
    const { randomMockMessage } = await import("../dev/mockData");
    const interval = window.setInterval(() => {
      const channels = useChat.getState().channels;
      if (channels.length === 0) return;
      const channel = channels[Math.floor(Math.random() * channels.length)];
      useChat.getState().ingest([randomMockMessage(channel)]);
    }, 1400);
    return () => window.clearInterval(interval);
  }

  const unlisteners = await Promise.all([
    listen<ChatMessage[]>("chat://messages", (event) => {
      useChat.getState().ingest(event.payload);
    }),

    listen<StatusEvent>("chat://status", (event) => {
      useChat.setState({
        connection: event.payload.state,
        connectionDetail: event.payload.detail,
      });
    }),

    listen<ClearEvent>("chat://clear", (event) => {
      useChat.getState().clear(event.payload);
    }),

    listen<ChannelReadyEvent>("chat://channel-ready", (event) => {
      useChat.setState((state) => ({
        ready: { ...state.ready, [event.payload.channel]: true },
        emoteCounts: { ...state.emoteCounts, [event.payload.channel]: event.payload.emoteCount },
      }));
      void useChat.getState().loadEmoteIndex(event.payload.channel);
    }),

    listen<Record<string, Badge>>("chat://seventv-badges", (event) => {
      useChat.setState((state) => ({
        seventvBadges: { ...state.seventvBadges, ...event.payload },
      }));
    }),

    listen<{ globalEmotes: number }>("chat://assets", (event) => {
      useChat.setState({ globalEmotes: event.payload.globalEmotes });
      // Global assets can land after a channel is already ready, so any index
      // built before this is missing Twitch's global emotes -- rebuild them.
      const state = useChat.getState();
      for (const channel of Object.keys(state.emoteEntries)) {
        void state.loadEmoteIndex(channel);
      }
    }),

    // Sent on join and whenever it changes -- see `ChannelRole` in the parser.
    listen<RoleEvent>("chat://role", (event) => {
      const { channel, moderator, broadcaster } = event.payload;
      useChat.setState((state) => ({
        roles: {
          ...state.roles,
          [channel]: broadcaster ? "broadcaster" : moderator ? "moderator" : "viewer",
        },
      }));
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
  ]);

  return () => unlisteners.forEach((off) => off());
}
