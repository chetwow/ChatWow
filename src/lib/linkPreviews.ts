/**
 * The session cache in front of what Rust reads off a page (`linkinfo.rs`).
 *
 * A link is cached whether or not it had anything to show: "no preview" is an
 * answer, and hovering the same link twice shouldn't ask its host twice. The
 * cap is here because chat is endless -- a long session sees thousands of
 * links, where the card cache sees the handful of names you clicked.
 */

import { api } from "./api";
import { IS_TAURI } from "./tauri";
import type { LinkPreview } from "../types";

/** Insertion-ordered, so the oldest entry is the first key. */
const cache = new Map<string, LinkPreview | null>();
const pending = new Map<string, Promise<LinkPreview | null>>();

const MAX_CACHED = 500;

function remember(url: string, preview: LinkPreview | null) {
  cache.set(url, preview);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** What we already hold, so a second hover draws instantly instead of spinning. */
export function cachedLinkPreview(url: string): LinkPreview | null | undefined {
  return cache.get(url);
}

/** What the page behind a link says about itself, or null when it says nothing. */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);

  const inFlight = pending.get(url);
  if (inFlight) return inFlight;

  const request = (
    IS_TAURI
      ? api.linkPreview(url)
      : import("../dev/mockData").then((mock) => mock.mockLinkPreview(url))
  )
    .then((preview) => {
      const found = preview?.title ? preview : null;
      remember(url, found);
      return found;
    })
    .catch(() => {
      // A host that refused or timed out is remembered as having no preview:
      // it won't start answering because the pointer passed over it again.
      remember(url, null);
      return null;
    })
    .finally(() => pending.delete(url));

  pending.set(url, request);
  return request;
}
