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
      provider: "twitch" | "7tv";
      overlays: Overlay[];
    }
  | { kind: "mention"; text: string }
  | { kind: "link"; text: string; href: string };

export type Badge = {
  id: string;
  title: string;
  /** Empty when we have no badge art (i.e. not signed in). */
  url: string;
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
  ts: number;
  login: string;
  displayName: string;
  color: string;
  badges: Badge[];
  segments: Segment[];
  isAction: boolean;
  isFirstMessage: boolean;
  kind: "chat" | "system" | "notice";
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

export type AuthStatus = {
  hasClientId: boolean;
  /**
   * A Client ID the user set by hand, replacing the one compiled into the
   * build. Null in the normal case, which is the shipped Twitch app.
   */
  clientIdOverride: string | null;
  loggedIn: boolean;
  login: string | null;
  /**
   * What the current token actually allows, as Twitch reports it -- not what
   * was asked for. Empty when signed out. This is what decides whether a
   * command can run.
   */
  scopes: string[];
  /** Optional permission group ids the next sign-in will ask for. */
  permissionGroups: string[];
  /** Every group there is, for drawing the account panel's checkboxes. */
  permissionCatalog: PermissionGroup[];
};

/** Chat text size presets, smallest first. Mirrors `chat_font_size` in Rust. */
export type ChatFontSize = "small" | "medium" | "large" | "larger";

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

/** Hand-mirrored from `settings::Preferences`; kept in `settings.json`. */
export type Preferences = {
  chatFontSize: ChatFontSize;
  /** Ping when someone writes `@you`. */
  notifyOnTag: boolean;
  /** Ping when someone uses your name without the `@`. */
  notifyOnName: boolean;
  /** Ping for mentions in the channel you're currently reading. */
  notifyActiveTab: boolean;
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
  channel: string | null;
  state: ConnectionState;
  detail: string | null;
};

export type ClearEvent = {
  channel: string;
  login?: string | null;
  messageId?: string | null;
  duration?: number | null;
};

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
  channel: string;
  moderator: boolean;
  broadcaster: boolean;
};

export type ChannelReadyEvent = {
  channel: string;
  emoteCount: number;
};
