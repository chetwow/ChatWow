import type { Badge, ChatMessage, EmoteEntry, EmoteIndex, Overlay, ReplyInfo, Segment } from "../types";

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
export function buildInitialMessages(): ChatMessage[] {
  const now = Date.now();
  return MOCK_CHANNELS.flatMap((channel, channelIndex) =>
    DRAFTS.map((draft, index) => toMessage(draft, channel, now + channelIndex * DRAFTS.length + index)),
  );
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
