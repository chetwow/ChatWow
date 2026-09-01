/**
 * What a link is, as far as the hover preview needs to know.
 *
 * A link straight to an image previews as that image, which needs nothing but
 * an `<img>` and the url. Everything else has to be asked what it is, which is
 * `linkinfo` in Rust; all this side decides is which of the two a link is.
 *
 * The test is the extension on the link's own path -- not the host, and not a
 * request. Asking each link what it is would mean every url in chat being
 * fetched to find out, which is the cost the preference exists to avoid. That
 * misses an image served from an extensionless url (an imgur page, a CDN whose
 * path is a hash), but a miss is a link behaving exactly as it always did,
 * where a guess is an empty frame over a page that was never an image.
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
