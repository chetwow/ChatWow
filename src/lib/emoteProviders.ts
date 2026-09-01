/**
 * Which third-party emote providers are switched on.
 *
 * Rust already skips a provider that's off: it never asks the service, so its
 * emotes aren't in any channel's map and won't resolve in messages arriving
 * afterwards. This is the other half -- the messages already on screen were
 * resolved before the switch and are immutable, so `EmoteView` asks here on
 * every render instead. Same reason the blacklists are matched in the frontend.
 *
 * Twitch's own emotes have no toggle. They arrive identified in the message's
 * own tags rather than from a service we chose to ask.
 */

/** The three flags, taken loose rather than as the whole `Preferences` object:
 *  `EmoteView` subscribes to each on its own, so an unrelated setting changing
 *  doesn't re-render every emote on screen. */
export type EnabledProviders = {
  seventv: boolean;
  bttv: boolean;
  ffz: boolean;
};

export function providerEnabled(provider: string, enabled: EnabledProviders): boolean {
  switch (provider) {
    case "7tv":
      return enabled.seventv;
    case "bttv":
      return enabled.bttv;
    case "ffz":
      return enabled.ffz;
    default:
      return true;
  }
}
