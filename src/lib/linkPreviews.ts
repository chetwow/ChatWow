/**
 * The session cache in front of what Rust reads off a page (`linkinfo.rs`).
 *
 * A link is cached whether or not it had anything to show: "no preview" is an
 * answer, and hovering the same link twice shouldn't ask its host twice. The
 * cap is here because chat is endless -- a long session sees thousands of
 * links, where the card cache sees the handful of names you clicked.
 */

import { api } from "./api";
import { MOCK_MODE } from "./tauri";
import type { LinkPreview } from "../types";

type Entry = {
  preview: LinkPreview | null;
  /** When this stops being worth trusting. `Infinity` for a page. */
  expires: number;
};

/** Insertion-ordered, so the oldest entry is the first key. */
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<LinkPreview | null>>();
const imageCache = new Map<string, string | null>();
const imagePending = new Map<string, Promise<string | null>>();

const MAX_CACHED = 500;
const MAX_IMAGE_CACHED = 40;

function remember(url: string, preview: LinkPreview | null) {
  const ttl = preview?.ttlSeconds ?? 0;
  cache.set(url, { preview, expires: ttl > 0 ? Date.now() + ttl * 1000 : Infinity });
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * What we already hold, so a second hover draws instantly instead of spinning
 * -- or `undefined` when there's nothing usable, which includes an answer that
 * has passed its shelf life and has to be asked for again.
 */
export function cachedLinkPreview(url: string): LinkPreview | null | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(url);
    return undefined;
  }
  return entry.preview;
}

/** What the page behind a link says about itself, or null when it says nothing. */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  const known = cachedLinkPreview(url);
  if (known !== undefined) return Promise.resolve(known);

  const inFlight = pending.get(url);
  if (inFlight) return inFlight;

  const request = (
    MOCK_MODE
      ? import("../dev/mockData").then((mock) => mock.mockLinkPreview(url))
      : api.linkPreview(url)
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

function localImage(mimeType: string, data: string): string {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function rememberImage(source: string, local: string | null) {
  imageCache.set(source, local);
  if (imageCache.size <= MAX_IMAGE_CACHED) return;
  const oldest = imageCache.keys().next().value;
  if (oldest === undefined) return;
  const discarded = imageCache.get(oldest);
  if (discarded) URL.revokeObjectURL(discarded);
  imageCache.delete(oldest);
}

/** A local blob URL for an image Rust fetched through the public-network gate. */
export function loadPreviewImage(source: string): Promise<string | null> {
  if (imageCache.has(source)) return Promise.resolve(imageCache.get(source) ?? null);
  const inFlight = imagePending.get(source);
  if (inFlight) return inFlight;

  const request = (MOCK_MODE
    ? Promise.resolve(source)
    : api
        .linkPreviewImage(source)
        .then((image) => (image ? localImage(image.mimeType, image.data) : null)))
    .catch(() => null)
    .then((local) => {
      rememberImage(source, local);
      return local;
    })
    .finally(() => imagePending.delete(source));
  imagePending.set(source, request);
  return request;
}
