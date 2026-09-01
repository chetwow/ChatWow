import type {
  AuthStatus,
  Badge,
  ChannelHit,
  ChatMessage,
  EmoteEntry,
  EmoteIndex,
  Overlay,
  ReplyInfo,
  Segment,
} from "../types";

/**
 * Sample data for design iteration in a plain browser (no Rust backend).
 * URLs are real CDN assets, confirmed to load, so emotes and badges look
 * exactly like they will in the real app -- this isn't just colored boxes.
 */

export const MOCK_CHANNELS = ["sodapoppin", "xqc", "forsen"];

const MOD: Badge = {
  id: "moderator/1",
  title: "Moderator",
  url: "https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/3",
};
const SUB: Badge = {
  id: "subscriber/12",
  title: "Subscriber (14 months)",
  url: "https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/3",
};
const PRIME: Badge = {
  id: "premium/1",
  title: "Prime Gaming",
  url: "https://static-cdn.jtvnw.net/badges/v1/bbbe0db0-a598-423e-86d0-f9fb98ca1933/3",
};
const VIP: Badge = {
  id: "vip/1",
  title: "VIP",
  url: "https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/3",
};

const RAIN_TIME_URL = "https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp";
const PETPET_URL = "https://cdn.7tv.app/emote/01FE3XY508000AA32JP519W2EW/2x.webp";

/** 7TV urls carry the emote id, which is what the image cache is keyed on. */
function idFromUrl(url: string): string {
  return url.match(/emote\/([^/]+)/)?.[1] ?? "";
}

function overlay(name: string, url: string): Overlay {
  return { id: idFromUrl(url), name, url, provider: "7tv" };
}

function sevenTv(name: string, url: string, overlays: Overlay[] = []): Segment {
  return {
    kind: "emote",
    id: idFromUrl(url),
    name,
    url,
    url_large: url.replace("/2x.", "/4x."),
    provider: "7tv",
    overlays,
  };
}

function twitch(id: string, name: string): Segment {
  return {
    kind: "emote",
    id,
    name,
    url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`,
    url_large: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`,
    provider: "twitch",
    overlays: [],
  };
}

function text(t: string): Segment {
  return { kind: "text", text: t };
}

type Draft = Partial<ChatMessage> & { login: string; displayName: string; color: string; segments: Segment[] };

const DRAFTS: Draft[] = [
  {
    login: "nightbot",
    displayName: "Nightbot",
    color: "#5F9EA0",
    badges: [MOD],
    segments: [text("Welcome to the channel! Be kind. "), sevenTv("Clap", "https://cdn.7tv.app/emote/01GAM8EFQ00004MXFXAJYKA859/2x.webp")],
  },
  {
    login: "luccid",
    displayName: "luccid",
    color: "#FF0000",
    badges: [SUB, PRIME],
    segments: [text("that play was insane "), twitch("305954156", "PogChamp"), text(" "), twitch("25", "Kappa")],
  },
  {
    login: "yumier_",
    displayName: "yumier_",
    color: "#00FF7F",
    segments: [
      sevenTv("PepePls", "https://cdn.7tv.app/emote/01GAFTZ9K80003DHH026MC7JW0/2x.webp"),
      text(" "),
      sevenTv("PepePls", "https://cdn.7tv.app/emote/01GAFTZ9K80003DHH026MC7JW0/2x.webp"),
    ],
  },
  {
    login: "opaxord",
    displayName: "opaxord",
    color: "#A358E8",
    badges: [VIP],
    segments: [
      text("overlay stacking: "),
      sevenTv("ppL", "https://cdn.7tv.app/emote/01GGD5PJA8000FH13S498E9D8X/2x.webp", [
        overlay("RainTime", RAIN_TIME_URL),
        overlay("PETPET", PETPET_URL),
      ]),
    ],
  },
  {
    login: "darkblueuser",
    displayName: "DarkBlueUser",
    color: "#6A6AFF",
    segments: [text("my raw color was #0000FF -- lifted for contrast")],
  },
  {
    login: "faiblesse",
    displayName: "faiblesse",
    color: "#AED3E5",
    badges: [SUB],
    segments: [
      text("hey "),
      { kind: "mention", text: "@opaxord" },
      text(" check "),
      { kind: "link", text: "https://7tv.app", href: "https://7tv.app" },
      text(" for emotes"),
    ],
  },
  {
    // Mock mode signs you in as "you", so these two exercise both halves of
    // the mention highlight: the @tag and the bare name.
    login: "poggerz",
    displayName: "poggerz",
    color: "#F2C14E",
    segments: [text("nice one "), { kind: "mention", text: "@you" }, text(" that clip was great")],
  },
  {
    login: "quietone",
    displayName: "quietone",
    color: "#7FB3D5",
    segments: [text("you were right about the patch notes")],
  },
  {
    login: "someone",
    displayName: "someone",
    color: "#FF69B4",
    segments: [text("waves at chat")],
    isAction: true,
  },
  {
    login: "newperson",
    displayName: "NewPerson",
    color: "#9ACD32",
    segments: [text("first time here, loving the stream!")],
    isFirstMessage: true,
  },
  {
    login: "giftgiver",
    displayName: "GiftGiver",
    color: "#DAA520",
    badges: [SUB],
    segments: [text("enjoy!")],
    kind: "system",
    systemMessage: "GiftGiver gifted 5 Tier 1 Subs to the community!",
  },
  {
    login: "chetwow",
    displayName: "chetwow",
    color: "#00CFFF",
    segments: [text("same, that combo was nuts")],
    replyTo: { login: "luccid", displayName: "luccid", body: "that play was insane PogChamp Kappa" },
  },
  {
    login: "chetbotwow",
    displayName: "chetbotwow",
    color: "#FF7F50",
    segments: [text("totally agree with you on that one")],
    replyTo: { login: "you", displayName: "You", body: "the new patch feels way more balanced" },
  },
];

let nextId = 1;

function toMessage(draft: Draft, channel: string, ts: number): ChatMessage {
  return {
    id: `mock-${nextId++}`,
    channel,
    ts,
    badges: [],
    isAction: false,
    isFirstMessage: false,
    kind: "chat",
    systemMessage: null,
    replyTo: null,
    ...draft,
  };
}

/** The initial backlog shown as soon as mock mode starts. */
/**
 * A whisper, shaped the way `render::whisper` sends one: no channel of its own
 * (the store files it under whichever you're reading), no badges, and text
 * resolved against the global emote set alone.
 */
function mockWhisper(): ChatMessage {
  return {
    id: "whisper-1",
    channel: "",
    ts: Date.now(),
    login: "forsen",
    displayName: "Forsen",
    color: "#5cd1a3",
    badges: [],
    segments: [{ kind: "text", text: "did you see that clip" }],
    isAction: false,
    isFirstMessage: false,
    kind: "whisper",
    systemMessage: null,
    replyTo: null,
  };
}

export function buildInitialMessages(): ChatMessage[] {
  const now = Date.now();
  return [
    ...MOCK_CHANNELS.flatMap((channel, channelIndex) =>
      DRAFTS.map((draft, index) =>
        toMessage(draft, channel, now + channelIndex * DRAFTS.length + index),
      ),
    ),
    mockWhisper(),
  ];
}

/** One more message, for the periodic mock "chat activity" while iterating. */
export function randomMockMessage(channel: string): ChatMessage {
  const draft = DRAFTS[Math.floor(Math.random() * DRAFTS.length)];
  return toMessage(draft, channel, Date.now());
}

/**
 * Enough names -- deliberately sharing prefixes -- to exercise completion
 * cycling, the picker's search and its most-used-first ranking without a
 * backend. Mixed case, since matching has to ignore case while the inserted
 * name keeps its own.
 *
 * Only a handful of real 7TV ids are on hand, so the images repeat across
 * names. That's the point of mock data: the rows are real CDN assets at the
 * real size rather than placeholder boxes.
 */
const SEVEN_TV_IDS = [
  "01GAM8EFQ00004MXFXAJYKA859", // Clap
  "01GAFTZ9K80003DHH026MC7JW0", // PepePls
  "01GGD5PJA8000FH13S498E9D8X", // ppL
  idFromUrl(RAIN_TIME_URL),
  idFromUrl(PETPET_URL),
];

const SEVEN_TV_NAMES = [
  "Aware", "AYAYA", "Clap", "Clueless", "COPIUM", "KEKW", "KEKWait", "LULE",
  "MODS", "monkaS", "monkaW", "OMEGALUL", "peepoHey", "peepoSad", "PepeLaugh",
  "Pepega", "PepegaAim", "PETPET", "PogU", "ppL", "RainTime", "Sadge",
  "widepeepoHappy", "xdding",
];

/** Real Twitch emote ids, so their rows load real art too. */
const TWITCH_EMOTES: [string, string][] = [
  ["25", "Kappa"],
  ["1902", "Keepo"],
  ["305954156", "PogChamp"],
  ["425618", "LUL"],
  ["354", "4Head"],
  ["245", "ResidentSleeper"],
];

/** Seeded counts, so the ranking is visibly doing something in mock mode. */
const EMOTE_USES: Record<string, number> = { PepegaAim: 9, KEKWait: 4, PogU: 2, Kappa: 6 };

export function mockEmoteIndex(): EmoteIndex {
  const entries: EmoteEntry[] = SEVEN_TV_NAMES.map((name, index) => {
    const id = SEVEN_TV_IDS[index % SEVEN_TV_IDS.length];
    return { id, name, url: `https://cdn.7tv.app/emote/${id}/2x.webp`, provider: "7tv" };
  });

  for (const [id, name] of TWITCH_EMOTES) {
    entries.push({
      id,
      name,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`,
      provider: "twitch",
    });
  }

  return {
    entries: entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    uses: { ...EMOTE_USES },
  };
}

const YOU_COLOR = "#7C5CFC";

/** Local echo of a message typed into the composer, for design iteration. */
export function buildOwnMockMessage(channel: string, raw: string, replyTo?: ReplyInfo): ChatMessage {
  const isAction = raw.startsWith("/me ") && raw.slice(4).trim().length > 0;
  const body = isAction ? raw.slice(4) : raw;
  return toMessage(
    {
      login: "you",
      displayName: "You",
      color: YOU_COLOR,
      segments: [text(body)],
      isAction,
      replyTo: replyTo ?? null,
    },
    channel,
    Date.now(),
  );
}

/** Stand-in channel search, so the join dialog is exercisable in mock mode. */
const MOCK_SEARCH: ChannelHit[] = [
  { login: "forsen", displayName: "Forsen", isLive: true, gameName: "Chess", thumbnailUrl: "" },
  { login: "forsenlol", displayName: "forsenlol", isLive: false, gameName: "", thumbnailUrl: "" },
  { login: "nymn", displayName: "NymN", isLive: true, gameName: "Just Chatting", thumbnailUrl: "" },
  { login: "nmplol", displayName: "Nmplol", isLive: false, gameName: "", thumbnailUrl: "" },
  { login: "sodapoppin", displayName: "sodapoppin", isLive: false, gameName: "", thumbnailUrl: "" },
  { login: "solary", displayName: "Solary", isLive: true, gameName: "VALORANT", thumbnailUrl: "" },
  { login: "xqc", displayName: "xQc", isLive: true, gameName: "Just Chatting", thumbnailUrl: "" },
];

export function mockSearchChannels(query: string): ChannelHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits = MOCK_SEARCH.filter((hit) => hit.login.includes(needle));
  // Live first, matching what the backend sorts.
  return [...hits].sort((a, b) => Number(b.isLive) - Number(a.isLive));
}

/**
 * The permission groups, mirrored from `auth::PERMISSION_GROUPS` so the
 * account panel's checkboxes and their tooltips can be designed without a
 * backend. Rust is the source; a drift here only affects this harness.
 */
const MOCK_PERMISSION_GROUPS = [
  {
    id: "chat",
    label: "Read and send chat",
    detail:
      "Reading chat and sending messages. Always requested -- it's what signing in is for.",
    scopes: ["chat:read", "chat:edit", "user:write:chat"],
    required: true,
  },
  {
    id: "account",
    label: "Your own account",
    detail:
      "Needed for the commands that act on your account rather than a channel: /color, /block, /unblock and /w.",
    scopes: ["user:manage:chat_color", "user:manage:blocked_users", "user:manage:whispers"],
    required: true,
  },
  {
    id: "moderation",
    label: "Moderator commands",
    detail:
      "Needed to run the moderator commands -- /ban, /timeout, /clear, /slow, /announce and the rest.",
    scopes: [
      "moderator:manage:banned_users",
      "moderator:manage:chat_messages",
      "moderator:manage:chat_settings",
      "moderator:manage:announcements",
      "moderator:manage:shoutouts",
      "moderator:manage:warnings",
    ],
    required: false,
  },
  {
    id: "channel",
    label: "Broadcaster commands",
    detail:
      "Needed to run the broadcaster commands -- /mod, /vip, /raid, /commercial and /marker.",
    scopes: [
      "channel:manage:moderators",
      "channel:manage:vips",
      "channel:manage:raids",
      "channel:edit:commercial",
      "channel:manage:broadcast",
    ],
    required: false,
  },
];

/**
 * `login` is set despite `loggedIn: false` -- matching real signed-out state
 * everywhere else -- so the "replying to you" highlight has an identity to
 * match against.
 *
 * The moderator scopes are granted, on the other hand, because the command
 * picker draws its locks from the scopes rather than the sign-in state: with
 * none of them the whole list would render locked and there'd be no unlocked
 * row to design against.
 */
export function mockAuthStatus(): AuthStatus {
  return {
    hasClientId: true,
    clientIdOverride: null,
    loggedIn: false,
    login: "you",
    scopes: MOCK_PERMISSION_GROUPS.filter((group) => group.id !== "channel").flatMap(
      (group) => group.scopes,
    ),
    permissionGroups: ["moderation"],
    permissionCatalog: MOCK_PERMISSION_GROUPS,
  };
}

/** What a slash command "reports" with no Helix to call. */
export function mockCommandResult(input: string): string {
  return `Mock mode: "${input.trim()}" wasn't sent anywhere.`;
}
