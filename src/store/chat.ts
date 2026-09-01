import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { IS_TAURI } from "../lib/tauri";
import { emotesIn } from "../lib/emoteComplete";
import type { Chatters } from "../lib/chatterComplete";
import { mentionKind } from "../lib/mentions";
import { normalizeRules, withRule, withoutRule } from "../lib/emoteBlacklist";
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
  ReplyInfo,
  StatusEvent,
  StoredMessage,
} from "../types";

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
  singleRowTabs: true,
  muted: false,
  emoteBlacklist: [],
  emoteCompleteBlacklist: [],
};

/** Which of the two blacklists an operation is about -- keyed by its own preference field. */
export type BlacklistKind = "emoteBlacklist" | "emoteCompleteBlacklist";

const FONT_SIZES = new Set<Preferences["chatFontSize"]>(["small", "medium", "large", "larger"]);

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
  return merged;
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

type ChatState = {
  channels: string[];
  active: string | null;
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

  setActive: (channel: string) => void;
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

export const useChat = create<ChatState>((set) => ({
  channels: [],
  active: null,
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

  setActive: (channel) =>
    set((state) => ({
      active: channel,
      unread: { ...state.unread, [channel]: 0 },
      mentions: { ...state.mentions, [channel]: 0 },
    })),

  join: async (channel) => {
    if (!IS_TAURI) {
      const name = channel.trim().replace(/^[#@]/, "").toLowerCase();
      if (!/^[a-z0-9_]{3,25}$/.test(name)) {
        throw new Error(`"${channel}" is not a valid Twitch channel name`);
      }
      set((state) =>
        state.channels.includes(name)
          ? {}
          : {
              channels: [...state.channels, name],
              active: state.active ?? name,
              ready: { ...state.ready, [name]: true },
            },
      );
      return;
    }

    const channels = await api.joinChannel(channel);
    const name = channels[channels.length - 1];
    set((state) => ({
      channels,
      active: channels.includes(state.active ?? "") ? state.active : name,
    }));
  },

  part: async (channel) => {
    if (!IS_TAURI) {
      const name = channel.trim().replace(/^[#@]/, "").toLowerCase();
      set((state) => {
        const channels = state.channels.filter((c) => c !== name);
        const messages = { ...state.messages };
        const sentHistory = { ...state.sentHistory };
        const mentions = { ...state.mentions };
        const chatters = { ...state.chatters };
        delete messages[name];
        delete sentHistory[name];
        delete mentions[name];
        delete chatters[name];
        return {
          channels,
          messages,
          sentHistory,
          mentions,
          chatters,
          active: state.active === name ? (channels[0] ?? null) : state.active,
        };
      });
      return;
    }

    const channels = await api.partChannel(channel);
    set((state) => {
      const messages = { ...state.messages };
      const sentHistory = { ...state.sentHistory };
      const mentions = { ...state.mentions };
      const chatters = { ...state.chatters };
      delete messages[channel];
      delete sentHistory[channel];
      delete mentions[channel];
      delete chatters[channel];
      return {
        channels,
        messages,
        sentHistory,
        mentions,
        chatters,
        active:
          state.active === channel ? (channels.length ? channels[0] : null) : state.active,
      };
    });
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
      // A whisper belongs to no channel -- Twitch delivers it outside chat --
      // so it goes wherever you're reading. With nothing open there's no view
      // to put it in, and it's dropped rather than filed under "".
      const routed = batch.flatMap((message) => {
        if (message.kind !== "whisper") return [message];
        return state.active ? [{ ...message, channel: state.active }] : [];
      });

      // Group by channel so each channel's array is rebuilt once per batch.
      const grouped = new Map<string, StoredMessage[]>();
      for (const message of routed) {
        const list = grouped.get(message.channel) ?? [];
        list.push({ ...message, key: nextKey++ });
        grouped.set(message.channel, list);
      }

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
        if (!muted && fresh.some((message) => message.kind === "whisper")) mentioned = true;
        // The channel you're looking at stays silent unless you ask for it:
        // you can already see the mention land.
        const audible = !muted && (channel !== state.active || notifyActiveTab);
        const naming = fresh.filter((message) => {
          const kind = mentionKind(message, state.auth.login);
          if (!kind) return false;
          // The badge and the highlight count every mention; only the sound
          // asks whether you wanted to hear about this kind of one.
          if (audible && (kind === "tag" ? notifyOnTag : notifyOnName)) mentioned = true;
          return true;
        });

        // Counted like unread is, and for the same reason: it's a tally of
        // what you haven't looked at, so the channel you're reading has none.
        if (channel !== state.active && fresh.length > 0) {
          unread[channel] = (unread[channel] ?? 0) + fresh.length;
          if (naming.length > 0) {
            mentions[channel] = (mentions[channel] ?? 0) + naming.length;
          }
        }
      }

      return { messages, unread, mentions, chatters };
    });

    // Muting, and the toggles above, only take the sound -- the highlight and
    // the badge are the quiet half of a mention and always happen.
    if (mentioned) playMentionSound();
  },

  clear: ({ channel, login, messageId }) => {
    set((state) => {
      const existing = state.messages[channel];
      if (!existing) return {};

      const next = existing.map((message) => {
        const hit = messageId
          ? message.id === messageId
          : login
            ? message.login === login
            : false;
        return hit ? { ...message, deleted: true } : message;
      });

      return { messages: { ...state.messages, [channel]: next } };
    });
  },

  bootstrap: async () => {
    if (!IS_TAURI) {
      const { MOCK_CHANNELS, buildInitialMessages, mockAuthStatus, mockSevenTvBadges } =
        await import("../dev/mockData");
      set({
        channels: MOCK_CHANNELS,
        active: MOCK_CHANNELS[0],
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
        preferences: readMockPreferences(),
      });
      useChat.getState().ingest(buildInitialMessages());
      return;
    }

    const [channels, auth, preferences] = await Promise.all([
      api.listChannels(),
      api.authStatus(),
      api.preferences(),
    ]);
    set((state) => ({
      channels,
      auth,
      preferences: normalize(preferences),
      active: state.active ?? channels[0] ?? null,
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
