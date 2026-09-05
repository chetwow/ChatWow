export type Overlay = {
  /** Provider id, for the on-disk image cache. */
  id: string;
  name: string;
  url: string;
  provider: string;
};

export type Segment =
  | { kind: "text"; text: string }
  | {
      kind: "emote";
      /** Provider id, for the on-disk image cache. */
      id: string;
      name: string;
      url: string;
      url_large: string;
      provider: EmoteProvider;
      overlays: Overlay[];
    }
  | { kind: "mention"; text: string }
  | { kind: "link"; text: string; href: string }
  | {
      kind: "gif";
      id: string;
      /** Twitch's accessible description and the fallback when hidden or unavailable. */
      text: string;
      /** The complete Twitch-supplied URL, which must not be rewritten. */
      url: string;
    };

export type Badge = {
  id: string;
  title: string;
  /** Empty when we have no badge art (i.e. not signed in). */
  url: string;
  /** Stable provider/id key for the shared persistent image cache. */
  cacheKey: string;
};

/** The message a reply is quoting, carried on the reply itself. */
export type ReplyInfo = {
  login: string;
  displayName: string;
  body: string;
};

export type ChatMessage = {
  id: string;
  channel: string;
  /**
   * Which account's connection received this, stamped by the backend. With
   * the same channel open under two accounts it's the only thing telling
   * their two copies apart, so it's what routes a message to its tab.
   */
  account: string;
  /** The sender's Twitch id -- what a 7TV badge is looked up by. */
  userId: string;
  ts: number;
  login: string;
  displayName: string;
  color: string;
  badges: Badge[];
  segments: Segment[];
  isAction: boolean;
  isFirstMessage: boolean;
  /**
   * `whisper` arrives outside chat entirely (EventSub, not IRC) and so has no
   * channel of its own -- the store files it under whichever one you're
   * reading. See `render::whisper` in Rust.
   */
  kind: "chat" | "system" | "notice" | "whisper";
  /**
   * Replayed from the history service on join rather than received live. Not
   * news, however recently it was said: it must never ping, redden a tab or
   * count as unread.
   */
  historical: boolean;
  systemMessage: string | null;
  replyTo: ReplyInfo | null;
};

/** A message after the store adds its local identity. */
export type StoredMessage = ChatMessage & {
  key: number;
  deleted?: boolean;
};

/**
 * One block of Twitch scopes the sign-in screen offers as a single choice,
 * hand-mirrored from `auth::PermissionGroup`.
 */
export type PermissionGroup = {
  id: string;
  label: string;
  /** Why you'd want it -- the checkbox's tooltip. */
  detail: string;
  scopes: string[];
  /** Asked for on every sign-in; shown, but not yours to clear. */
  required: boolean;
};

/**
 * The account a tab reads as when it has none. Not a broken state: Twitch
 * serves chat to an anonymous login, which is how this app works before you
 * ever sign in, and stays a per-tab choice afterwards.
 */
export const ANONYMOUS = "";

/** One signed-in account, hand-mirrored from `state::AccountInfo`. */
export type AccountInfo = {
  /** Twitch's numeric user id -- what a tab points at, and stable across a rename. */
  id: string;
  login: string;
  /**
   * What this account's token actually allows, as Twitch reports it -- not
   * what was asked for. This is what decides whether a command can run, and
   * it's per account: two logins can differ in what they may do.
   */
  scopes: string[];
  /**
   * The account's Twitch profile picture. Empty when Twitch has none for them
   * or hasn't been asked yet -- the accounts list falls back to a monogram.
   */
  avatarUrl: string;
};

export type AuthStatus = {
  hasClientId: boolean;
  /**
   * A Client ID the user set by hand, replacing the one compiled into the
   * build. Null in the normal case, which is the shipped Twitch app. One
   * Client ID covers every account -- it identifies the app, not the user.
   */
  clientIdOverride: string | null;
  /** Every signed-in account. Empty is the ordinary signed-out state. */
  accounts: AccountInfo[];
  /** Which account a newly opened tab reads as. `ANONYMOUS` for none. */
  defaultAccount: string;
  /**
   * Optional permission group ids the next sign-in will ask for. Shared: it's
   * what to *request*, where what each account was granted rides on it.
   */
  permissionGroups: string[];
  /** Every group there is, for drawing the account panel's checkboxes. */
  permissionCatalog: PermissionGroup[];
};

/**
 * One open tab, hand-mirrored from `settings::Tab`.
 *
 * The unit the app is built around: the same channel can be open twice under
 * two accounts, so a channel name no longer identifies a view. `id` does, and
 * everything kept per view -- messages, unread, scroll position -- is keyed by
 * it.
 */
export type Tab = {
  id: string;
  kind: "channel" | "mentions";
  /** Empty for a mentions tab, which belongs to an account rather than a room. */
  channel: string;
  /** The account it reads and sends as, or `ANONYMOUS`. */
  account: string;
  /**
   * This tab's own answer to which picture sits behind its name. Stamped from
   * `newTabAvatarMode` when the tab is opened and its own from then on, so
   * changing that preference leaves the open tabs where they were.
   */
  avatarMode: TabAvatarMode;
  /** Custom listener definition; null on channels and legacy mentions tabs. */
  mention: MentionFilter | null;
};

/** The persisted filter owned by a custom mentions tab. */
export type MentionFilter = {
  name: string;
  /** Signed-in account ids whose logins are watched. */
  accounts: string[];
  /** Chatter logins whose every message is watched. */
  users: string[];
  /** Open channel names whose incoming messages are watched. */
  channels: string[];
  /** Case-insensitive substrings that also qualify a message. */
  phrases: string[];
  /** Whether matches play the mention sound and use the rose tab badge. */
  notify: boolean;
};

/** Which picture a tab draws behind its name. */
export type TabAvatarMode = "none" | "owner" | "account";

/**
 * What a *new* tab is stamped with. The three a tab can hold, plus the rule
 * `otherAccount`: your picture only where the tab isn't on your default
 * account, which resolves to one of the other three as the tab is opened.
 */
export type NewTabAvatarMode = TabAvatarMode | "otherAccount";

/** Chat text size presets, smallest first. Mirrors `chat_font_size` in Rust. */
export type ChatFontSize = "small" | "medium" | "large" | "larger";

/** Built-in color schemes. Mirrors the unvalidated `theme` string in Rust. */
export type ThemeId = "twitch" | "midnight" | "lagoon" | "evergreen" | "ember" | "sakura";

/** What occupies the account slot beside the composer. */
export type ComposerAvatarMode = "twitch" | "generic" | "none";

/**
 * One emote blacklist entry, hand-mirrored from `settings::EmoteRule`.
 *
 * A `name` rule catches every emote going by that name, in any channel -- which
 * is what you want for a 7TV alias spammed as a single letter. An `id` rule
 * carries the `<provider>-<id>` image key and catches one specific image
 * however it happens to be aliased.
 */
export type EmoteRule = {
  kind: "name" | "id";
  value: string;
};

/**
 * Which of the two panes something is in. There are exactly two: one split,
 * not a tree of them, so this is an index rather than a path.
 */
export type PaneIndex = 0 | 1;

/**
 * How the window is divided: not at all, into two panes side by side, or into
 * two stacked one above the other.
 */
export type SplitLayout = "none" | "row" | "column";

/** Hand-mirrored from `settings::Preferences`; kept in `settings.json`. */
export type Preferences = {
  /** Color scheme applied to the whole window. */
  theme: ThemeId;
  chatFontSize: ChatFontSize;
  /** Ping when someone writes `@you`. */
  notifyOnTag: boolean;
  /** Ping when someone uses your name without the `@`. */
  notifyOnName: boolean;
  /** Ping for mentions in the channel you're currently reading. */
  notifyActiveTab: boolean;
  /** Ask before the last channel feeding a mentions listener is closed. */
  warnOnListenerClose: boolean;
  /** Load a channel's recent messages when you join it. */
  showMessageHistory: boolean;
  /** Duration used by the one-click moderator timeout action. */
  defaultTimeoutSeconds: number;
  /**
   * Ask GitHub for a newer release a moment after launch. Nothing is
   * downloaded until it's asked for either way.
   */
  checkForUpdates: boolean;
  /** Third-party emote providers, each on by default. */
  enableSeventv: boolean;
  enableBttv: boolean;
  enableFfz: boolean;
  /** Show the 7TV badge a chatter has equipped, beside their Twitch ones. */
  showSeventvBadges: boolean;
  /** Draw Twitch GIF messages inline; when off, show their caption with a hover preview. */
  showGifs: boolean;
  /** GIF size relative to the default, from 0.25 to 2. */
  gifScale: number;
  /** Draw `/me` actions in italics. */
  italicActions: boolean;
  /** Show the time beside each message. */
  showTimestamps: boolean;
  /** Keep the window above every other one. */
  alwaysOnTop: boolean;
  /** What occupies the account slot beside the message box. */
  composerAvatarMode: ComposerAvatarMode;
  /** What a newly opened tab draws behind its name. Only new ones. */
  newTabAvatarMode: NewTabAvatarMode;
  /** How strongly that picture is drawn, 0 to 1. */
  tabAvatarOpacity: number;
  /**
   * Show the picture on hover for a link that is one: straight at an image, or
   * at a 7TV emote, which is the same promise by way of one API call.
   */
  previewImages: boolean;
  /** Show what the page says about itself on hover, for every other link. */
  previewPages: boolean;
  /** Keep the tabs on one scrolling row instead of wrapping onto several. */
  singleRowTabs: boolean;
  /** Whether the window is split, and along which axis. */
  splitLayout: SplitLayout;
  /** The first pane's share of the split axis, as a fraction. */
  splitRatio: number;
  /** How many leading tabs belong to the first pane; the rest to the second. */
  splitIndex: number;
  /** Mentions to stay quiet about: `@login` or `#channel`, in one list. */
  mentionIgnores: string[];
  /** Logins whose messages aren't drawn at all. */
  blockedUsers: string[];
  /** The title bar's quick mute, which leaves the two toggles above alone. */
  muted: boolean;
  /** Emotes drawn as their underlined name instead of their image. */
  emoteBlacklist: EmoteRule[];
  /** Emotes kept out of Tab completion and the `:` picker. */
  emoteCompleteBlacklist: EmoteRule[];
};

export type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export type StatusEvent = {
  /** Which account's socket this is about -- there's one per account. */
  account: string;
  state: ConnectionState | "closed";
  detail: string | null;
};

export type ClearEvent = {
  account: string;
  channel: string;
  login?: string | null;
  messageId?: string | null;
  duration?: number | null;
};

/** Where an emote came from. Twitch's own are never optional; the rest are. */
export type EmoteProvider = "twitch" | "7tv" | "bttv" | "ffz";

/** One emote the composer can complete to and the picker can show. */
export type EmoteEntry = {
  /** Provider id. Keys the image cache, and stays put when a 7TV name is aliased. */
  id: string;
  name: string;
  /** CDN url, used until the cached copy is on disk. */
  url: string;
  provider: string;
};

/** Everything the composer and emote picker need for a channel. */
export type EmoteIndex = {
  /** Completable emotes, sorted case-insensitively by name. */
  entries: EmoteEntry[];
  /** Send count per emote name, across all channels. */
  uses: Record<string, number>;
};

/** One channel-search suggestion, hand-mirrored from `twitch::search::ChannelHit`. */
export type ChannelHit = {
  /** The lowercase name to join. */
  login: string;
  /** How the broadcaster capitalizes it -- display only. */
  displayName: string;
  isLive: boolean;
  /** Empty when offline, or when Twitch has no game for the stream. */
  gameName: string;
  /** Profile image, empty if Twitch gave us none. */
  thumbnailUrl: string;
};

/**
 * What you are in a channel, from your own USERSTATE. `viewer` is also what an
 * unanswered channel reads as, which is the safe way round: the picker offers
 * less rather than offering a command Twitch will refuse.
 */
export type ChannelRole = "broadcaster" | "moderator" | "viewer";

export type RoleEvent = {
  /** Per account: one of your logins can be a mod here and another not. */
  account: string;
  channel: string;
  moderator: boolean;
  broadcaster: boolean;
};

/**
 * What this chatter is to this channel, hand-mirrored from `usercard::History`.
 *
 * Absent from a `UserCard` entirely when the third-party service behind it
 * didn't answer -- which the card has to say, because it isn't the same claim
 * as "doesn't follow, never subscribed".
 */
export type UserHistory = {
  /** ISO 8601, empty when they don't follow the channel. */
  followedAt: string;
  /** Cumulative months subscribed, counting past subscriptions. 0 if never. */
  subMonths: number;
  /** "1", "2" or "3". Empty unless they're subscribed right now. */
  subTier: string;
  subscribed: boolean;
  /** They've hidden it, so the three fields above say nothing about subs. */
  subHidden: boolean;
};

/**
 * The card behind a clicked username, hand-mirrored from `usercard::UserCard`.
 * No display name or color: the message that was clicked already carries both.
 */
export type UserCard = {
  /** Empty when neither source had one; the card draws initials instead. */
  avatarUrl: string;
  /** Account creation, ISO 8601. Empty when neither source answered. */
  createdAt: string;
  history: UserHistory | null;
};

/** One labelled row under a link preview's title, from `linkinfo::Fact`. */
export type LinkFact = {
  label: string;
  value: string;
};

/**
 * What the page behind a link says about itself, hand-mirrored from
 * `linkinfo::LinkPreview`. Already formatted: a duration is "4:46", a count is
 * "1.2M", a date is "3 Mar 2023" -- the card draws these, it doesn't compute
 * them. Empty strings mean the page published nothing there.
 */
export type LinkPreview = {
  title: string;
  description: string;
  /** Thumbnail url. Often a different host from the link itself. */
  image: string;
  facts: LinkFact[];
  /**
   * How long this answer is worth keeping, in seconds; 0 means forever. A
   * live stream's viewer count and uptime are wrong within minutes, so that
   * preview says so rather than the cache having to guess which answers rot.
   */
  ttlSeconds: number;
};

export type PreviewImage = {
  mimeType: string;
  data: string;
};

export type ChannelReadyEvent = {
  /** Whose join finished: a second account in the same room loads its own. */
  account: string;
  channel: string;
  emoteCount: number;
};

/**
 * A channel's emote set changed under it, pushed by 7TV. No account: the set
 * belongs to the room, so every tab on that channel is looking at the new one.
 */
export type EmoteSetEvent = {
  channel: string;
  emoteCount: number;
};

/**
 * Where the update machinery has got to. `ready` never happens on Windows --
 * the installer takes the process with it and puts the app back up itself.
 */
export type UpdateStage =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "failed";

/** Hand-mirrored from `updater::UpdateState`. */
export type UpdateState = {
  stage: UpdateStage;
  /** This build. The only place the frontend learns what version it is. */
  currentVersion: string;
  /** The newer version, once one is known. */
  version: string | null;
  /** The release notes, as they were written on the release. */
  notes: string | null;
  downloaded: number;
  /** `null` when the download had no declared length, so it has no percentage. */
  total: number | null;
  /** One short line. The detail is in the log. */
  error: string | null;
  /**
   * Whether this build can replace itself. False on macOS until the app is
   * signed, where the new version is real but applying it would break the
   * install.
   */
  canInstall: boolean;
};
