import type {
  AccountInfo,
  AuthStatus,
  Badge,
  ChannelHit,
  ChatMessage,
  EmoteEntry,
  EmoteIndex,
  LinkPreview,
  Overlay,
  ReplyInfo,
  Segment,
  Tab,
  UserCard,
} from "../types";

/**
 * Sample data for design iteration in a plain browser (no Rust backend).
 * URLs are real CDN assets, confirmed to load, so emotes and badges look
 * exactly like they will in the real app -- this isn't just colored boxes.
 */

export const MOCK_CHANNELS = ["sodapoppin", "xqc", "forsen"];

/** Real Twitch profile images, so the user card and the accounts list show real ones. */
const FORSEN_AVATAR =
  "https://static-cdn.jtvnw.net/jtv_user_pictures/forsen-profile_image-48b43e1e4f54b5c8-600x600.png";
const NYMN_AVATAR =
  "https://static-cdn.jtvnw.net/jtv_user_pictures/aa24a66f-6cb9-48da-8bcc-80cbf725f99e-profile_image-600x600.png";

/**
 * Owner avatars for the mock channels, so the tab background's `owner` mode
 * has something to draw. Only two of the three: a channel nobody has fetched
 * a face for is the ordinary case (just joined, or signed out) and the tab
 * has to look right in it.
 */
export const MOCK_CHANNEL_AVATARS: Record<string, string> = {
  [MOCK_CHANNELS[0]]: NYMN_AVATAR,
  [MOCK_CHANNELS[2]]: FORSEN_AVATAR,
};

/**
 * Three accounts, so the multi-account paths -- a tab per account, the same
 * channel open twice, the account picker on a tab and on the composer -- are
 * all exercisable without signing in to Twitch. Two have tabs; the third is
 * signed in and idle.
 */
export const MOCK_ACCOUNTS: AccountInfo[] = [
  { id: "1", login: "you", scopes: [], avatarUrl: FORSEN_AVATAR },
  { id: "2", login: "you_alt", scopes: [], avatarUrl: NYMN_AVATAR },
  // Signed in, no tabs and no picture -- the accounts list's monogram and its
  // "No tabs" row, and the one account a tab's picture can't come from.
  { id: "3", login: "you_spare", scopes: [], avatarUrl: "" },
];

/**
 * The tabs mock mode opens with: two channels as the first account, one as the
 * second, and the same channel a second time under the other account -- which
 * is the case the whole feature exists for.
 */
export function mockTabs(): Tab[] {
  return [
    // Three of the modes across four tabs, since a tab carries its own now.
    { id: "mock-tab-1", kind: "channel", channel: MOCK_CHANNELS[0], account: "1", avatarMode: "account" },
    { id: "mock-tab-2", kind: "channel", channel: MOCK_CHANNELS[1], account: "1", avatarMode: "none" },
    { id: "mock-tab-3", kind: "channel", channel: MOCK_CHANNELS[2], account: "2", avatarMode: "owner" },
    { id: "mock-tab-4", kind: "channel", channel: MOCK_CHANNELS[0], account: "2", avatarMode: "account" },
  ];
}

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

/** Real ids, so the images load from the providers' own CDNs like the 7TV ones. */
const BTTV_EMOTES: [string, string][] = [
  ["5590b223b344e2c42a9e28e3", "haHAA"],
  ["566ca38765dbbdab32ec0560", "SourPls"],
];
const FFZ_EMOTES: [string, string][] = [
  ["28138", "CatBag"],
  ["25927", "ZreknarF"],
];

function bttv(name: string): Segment {
  const id = BTTV_EMOTES.find(([, code]) => code === name)?.[0] ?? "";
  return {
    kind: "emote",
    id,
    name,
    url: `https://cdn.betterttv.net/emote/${id}/2x`,
    url_large: `https://cdn.betterttv.net/emote/${id}/3x`,
    provider: "bttv",
    overlays: [],
  };
}

function ffz(name: string): Segment {
  const id = FFZ_EMOTES.find(([, code]) => code === name)?.[0] ?? "";
  return {
    kind: "emote",
    id,
    name,
    url: `https://cdn.frankerfacez.com/emote/${id}/2`,
    url_large: `https://cdn.frankerfacez.com/emote/${id}/4`,
    provider: "ffz",
    overlays: [],
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
    // One of each third-party provider, so the Emotes tab's toggles have
    // something to switch off in the preview.
    login: "provider_check",
    displayName: "provider_check",
    color: "#F5A9B8",
    segments: [
      text("7tv "),
      sevenTv("Clap", "https://cdn.7tv.app/emote/01GAM8EFQ00004MXFXAJYKA859/2x.webp"),
      text(" bttv "),
      bttv("haHAA"),
      text(" ffz "),
      ffz("CatBag"),
    ],
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
    // One link of each kind the preview handles: a picture, a page with a
    // card's worth of metadata, and one with nothing to say.
    login: "linkposter",
    displayName: "linkposter",
    color: "#7FE3A0",
    segments: [
      text("look at this "),
      { kind: "link", text: FORSEN_AVATAR, href: FORSEN_AVATAR },
    ],
  },
  {
    login: "clipper",
    displayName: "clipper",
    color: "#9AD3E5",
    segments: [
      text("chat "),
      {
        kind: "link",
        text: "https://clips.twitch.tv/SoftKindPuppyKappa-abc123",
        href: "https://clips.twitch.tv/SoftKindPuppyKappa-abc123",
      },
      text(" and "),
      { kind: "link", text: "https://twitch.tv/forsen", href: "https://twitch.tv/forsen" },
    ],
  },
  {
    login: "songrequest",
    displayName: "songrequest",
    color: "#E39A7F",
    segments: [
      text("banger "),
      { kind: "link", text: "https://youtu.be/qMpBobAonKs", href: "https://youtu.be/qMpBobAonKs" },
      text(" and "),
      { kind: "link", text: "https://example.com/nothing", href: "https://example.com/nothing" },
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

function toMessage(draft: Draft, tab: Tab, ts: number): ChatMessage {
  return {
    id: `mock-${nextId++}`,
    channel: tab.channel,
    // Stamped the way the backend stamps a real one: it's what routes a
    // message to its tab when the same channel is open twice.
    account: tab.account,
    // Stable per chatter, the way a real user id is -- it's what the 7TV
    // badges below are keyed by.
    userId: `mock-${draft.login}`,
    ts,
    badges: [],
    isAction: false,
    isFirstMessage: false,
    kind: "chat",
    historical: false,
    systemMessage: null,
    replyTo: null,
    ...draft,
  };
}

/**
 * A whisper, shaped the way `render::whisper` sends one: no channel of its own
 * (the store files it under whichever you're reading), no badges, and text
 * resolved against the global emote set alone.
 */
function mockWhisper(account: string): ChatMessage {
  return {
    id: "whisper-1",
    channel: "",
    account,
    userId: "mock-forsen",
    ts: Date.now(),
    login: "forsen",
    displayName: "Forsen",
    color: "#5cd1a3",
    badges: [],
    segments: [{ kind: "text", text: "did you see that clip" }],
    isAction: false,
    isFirstMessage: false,
    kind: "whisper",
    historical: false,
    systemMessage: null,
    replyTo: null,
  };
}

/** The initial backlog shown as soon as mock mode starts. */
export function buildInitialMessages(tabs: Tab[]): ChatMessage[] {
  const now = Date.now();
  return [
    ...tabs.flatMap((tab, tabIndex) =>
      DRAFTS.map((draft, index) => toMessage(draft, tab, now + tabIndex * DRAFTS.length + index)),
    ),
    mockWhisper(tabs[0]?.account ?? "1"),
  ];
}

/** One more message, for the periodic mock "chat activity" while iterating. */
export function randomMockMessage(tab: Tab): ChatMessage {
  const draft = DRAFTS[Math.floor(Math.random() * DRAFTS.length)];
  return toMessage(draft, tab, Date.now());
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

/**
 * 7TV badges keyed by the mock user ids above. Real badge art, so the row
 * looks like it does against the live API.
 */
export function mockSevenTvBadges(): Record<string, Badge> {
  return {
    "mock-luccid": {
      id: "7tv-01JJJ74CRHZBRMCM8F4Y2WBN6R",
      title: "Minecraft Event Winner",
      url: "https://cdn.7tv.app/badge/01JJJ74CRHZBRMCM8F4Y2WBN6R/2x_static.webp",
    },
    "mock-faiblesse": {
      id: "7tv-01JF2VMDBWMZDXZKF4D33VM2S8",
      title: "NNYS Golden Gondola",
      url: "https://cdn.7tv.app/badge/01JF2VMDBWMZDXZKF4D33VM2S8/2x.webp",
    },
  };
}

/**
 * User cards, one per shape the real thing can take: subscribed, lapsed,
 * neither, hidden, and the third-party half not answering at all. Keyed by
 * login so clicking around mock chat walks through all five, and so a given
 * name always says the same thing.
 */
const USER_CARDS: Record<string, UserCard> = {
  luccid: {
    avatarUrl: FORSEN_AVATAR,
    createdAt: "2011-05-19T00:28:28Z",
    history: {
      followedAt: "2015-07-03T10:28:10Z",
      subMonths: 148,
      subTier: "3",
      subscribed: true,
      subHidden: false,
    },
  },
  faiblesse: {
    avatarUrl: NYMN_AVATAR,
    createdAt: "2014-05-08T15:19:18Z",
    history: {
      followedAt: "2019-11-22T09:02:00Z",
      subMonths: 124,
      subTier: "",
      subscribed: false,
      subHidden: false,
    },
  },
  quietone: {
    // No avatar, so the monogram fallback gets exercised too.
    avatarUrl: "",
    createdAt: "2024-02-29T12:00:00Z",
    history: { followedAt: "", subMonths: 0, subTier: "", subscribed: false, subHidden: false },
  },
  nightbot: {
    avatarUrl: "",
    createdAt: "2013-01-14T08:30:00Z",
    history: { followedAt: "2021-06-01T00:00:00Z", subMonths: 0, subTier: "", subscribed: false, subHidden: true },
  },
  provider_check: {
    avatarUrl: NYMN_AVATAR,
    createdAt: "2018-08-08T18:08:08Z",
    // ivr.fi didn't answer: the card has to say so rather than claim nothing.
    history: null,
  },
};

/** Anyone without a card of their own gets one of the five, stably. */
export function mockUserCard(login: string): UserCard {
  const known = USER_CARDS[login];
  if (known) return known;
  const shapes = Object.values(USER_CARDS);
  const hash = [...login].reduce((total, char) => total + char.charCodeAt(0), 0);
  return shapes[hash % shapes.length];
}

/**
 * Mock mode has no backend to fetch a page with, so a link that isn't an image
 * gets a canned preview for its host. Anything unlisted has none, which is the
 * other half worth being able to see: the spinner goes up, then nothing.
 */
const LINK_PREVIEWS: Record<string, LinkPreview> = {
  "7tv.app": {
    title: "7TV",
    description: "The emote platform for Twitch, YouTube and Kick.",
    image: "",
    facts: [],
    ttlSeconds: 0,
  },
  "clips.twitch.tv": {
    title: "insane play",
    description: "",
    image: FORSEN_AVATAR,
    facts: [
      { label: "Channel", value: "Forsen" },
      { label: "Clipped by", value: "someone" },
      { label: "Game", value: "Minecraft" },
      { label: "Length", value: "0:28" },
      { label: "Views", value: "15K" },
      { label: "Clipped", value: "2 Nov 2024" },
    ],
    ttlSeconds: 0,
  },
  "twitch.tv": {
    title: "wide peepo",
    description: "",
    image: FORSEN_AVATAR,
    facts: [
      { label: "Channel", value: "Forsen" },
      { label: "Playing", value: "Minecraft" },
      { label: "Viewers", value: "25K" },
      { label: "Live for", value: "2h 14m" },
    ],
    // Live: the frontend cache re-asks once this runs out.
    ttlSeconds: 120,
  },
  "youtu.be": {
    title: "Hold Me Now",
    description:
      "Provided to YouTube by BMG Rights Management (UK) Ltd. Hold Me Now \u00b7 Thompson Twins \u00b7 Arista Heritage Series.",
    image: "https://i.ytimg.com/vi/qMpBobAonKs/maxresdefault.jpg",
    facts: [
      { label: "Channel", value: "Thompson Twins - Topic" },
      { label: "Duration", value: "4:46" },
      { label: "Published", value: "3 Mar 2023" },
      { label: "Views", value: "1.2M" },
      { label: "Likes", value: "17,430" },
    ],
    ttlSeconds: 0,
  },
};

/** Deliberately slow, so the spinner before a card appears is visible. */
export function mockLinkPreview(url: string): Promise<LinkPreview | null> {
  let host = "";
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return Promise.resolve(null);
  }
  const preview = LINK_PREVIEWS[host] ?? null;
  return new Promise((resolve) => window.setTimeout(() => resolve(preview), 700));
}

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

  for (const [id, name] of BTTV_EMOTES) {
    entries.push({ id, name, url: `https://cdn.betterttv.net/emote/${id}/2x`, provider: "bttv" });
  }

  for (const [id, name] of FFZ_EMOTES) {
    entries.push({ id, name, url: `https://cdn.frankerfacez.com/emote/${id}/2`, provider: "ffz" });
  }

  return {
    entries: entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    uses: { ...EMOTE_USES },
  };
}

const YOU_COLOR = "#7C5CFC";

/** Local echo of a message typed into the composer, for design iteration. */
export function buildOwnMockMessage(
  tab: Tab,
  login: string,
  raw: string,
  replyTo?: ReplyInfo,
): ChatMessage {
  const isAction = raw.startsWith("/me ") && raw.slice(4).trim().length > 0;
  const body = isAction ? raw.slice(4) : raw;
  return toMessage(
    {
      login,
      displayName: login,
      color: YOU_COLOR,
      segments: [text(body)],
      isAction,
      replyTo: replyTo ?? null,
    },
    tab,
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
  // The first account holds everything but the broadcaster group and the
  // second only the basics, so the command picker's locked rows and the
  // "this account can't do that" paths are both visible while iterating.
  const granted = MOCK_PERMISSION_GROUPS.filter((group) => group.id !== "channel").flatMap(
    (group) => group.scopes,
  );
  const basics = MOCK_PERMISSION_GROUPS.find((group) => group.id === "chat")?.scopes ?? [];
  return {
    hasClientId: true,
    clientIdOverride: null,
    accounts: [
      { ...MOCK_ACCOUNTS[0], scopes: granted },
      { ...MOCK_ACCOUNTS[1], scopes: basics },
      MOCK_ACCOUNTS[2],
    ],
    defaultAccount: MOCK_ACCOUNTS[0].id,
    permissionGroups: ["moderation"],
    permissionCatalog: MOCK_PERMISSION_GROUPS,
  };
}

/** What a slash command "reports" with no Helix to call. */
export function mockCommandResult(input: string): string {
  return `Mock mode: "${input.trim()}" wasn't sent anywhere.`;
}
