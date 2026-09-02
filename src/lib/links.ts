/**
 * What a link is, as far as the hover preview needs to know.
 *
 * A link straight to an image previews as that image, which needs nothing but
 * an `<img>` and the url. Everything else has to be asked what it is, which is
 * `linkinfo` in Rust; this side decides only which *kind* of link it is, since
 * each kind has its own switch and a switch has to be read before the asking.
 *
 * An image is settled by the extension on the link's own path -- not the host,
 * and not a request. Asking each link what it is would mean every url in chat
 * being fetched to find out, which is the cost the preferences exist to avoid.
 * That misses an image served from an extensionless url (an imgur page, a CDN
 * whose path is a hash), but a miss is a link behaving exactly as it always
 * did, where a guess is an empty frame over a page that was never an image.
 *
 * A 7TV emote link is the third case, and it sits under the image switch: it
 * isn't an image url, but what it previews *as* is a picture, from one call to
 * an API this app already talks to. Deciding that here rather than from what
 * comes back is the same rule as everything else on this side -- the switch has
 * to be read before anything is asked -- and it's the only link whose kind
 * needs a path as well as a host, an emote page being one shape among many on
 * that site.
 */

/** What a webview will actually decode in an `<img>`. */
const EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

/**
 * The image to preview for this link, or null if it isn't one.
 *
 * Returns the url rather than a boolean because the caller needs something to
 * put in an `<img src>`, and this is the one place that has decided the link
 * is safe to put there.
 */
export function imagePreviewUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Links only ever arrive as http(s) from `render::is_link`, but this is what
  // reaches an `<img src>`, so it checks rather than assumes.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const dot = url.pathname.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS.has(url.pathname.slice(dot + 1).toLowerCase()) ? url.href : null;
}

/** The host to show under a page title -- where the link actually goes. */
export function linkHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

/** Which switch a link answers to, and what it previews as. */
export type LinkKind = "image" | "emote" | "page";

const SEVENTV_HOSTS = new Set(["7tv.app", "old.7tv.app", "7tv.io"]);

/**
 * Whether this is a link to one 7TV emote. Mirrors `seventv_links::parse` in
 * Rust, which is what actually resolves it -- this side only has to be right
 * about which switch applies, so it checks the shape of the path and leaves
 * whether the id exists to the API.
 */
function isEmoteLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  // `www.` is the only subdomain worth folding away; the rest are listed.
  if (!SEVENTV_HOSTS.has(url.host.toLowerCase().replace(/^www\./, ""))) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  // `/v3/emotes/<id>` reaches the same emote as `/emotes/<id>`.
  const path = /^v\d$/.test(segments[0] ?? "") ? segments.slice(1) : segments;
  return path.length === 2 && path[0] === "emotes" && /^[A-Za-z0-9]{20,32}$/.test(path[1]);
}

export function linkKind(href: string): LinkKind {
  if (imagePreviewUrl(href)) return "image";
  if (isEmoteLink(href)) return "emote";
  return "page";
}
