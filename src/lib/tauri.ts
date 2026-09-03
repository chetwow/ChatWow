import { isTauri } from "@tauri-apps/api/core";

/**
 * True inside the real app, false when the same Vite build is opened directly
 * in a browser (`npm run dev`, no `tauri dev`). Lets the store fall back to
 * mock data instead of failing every `invoke` call, so UI work doesn't pay
 * for a Rust rebuild on every change.
 */
export const IS_TAURI = isTauri();

/**
 * True on macOS, where the window keeps its native frame: rounded corners, the
 * system shadow, and the traffic lights drawn over our own title bar rather
 * than window buttons of our own on the right. See `tauri.macos.conf.json`.
 *
 * Not gated on `IS_TAURI`, so `npm run dev` on a Mac previews the same layout.
 * The gap the lights sit in is empty in a browser tab, which is the one thing
 * the preview can't show.
 */
export const IS_MACOS = navigator.userAgent.includes("Macintosh");

/**
 * How tall the title bar is, in px. Taller on macOS to give the traffic lights
 * room, since they're a system size and can't be scaled.
 *
 * Shared rather than repeated: the modals sit below the bar so the lights are
 * never drawn over a dialog, and a bar that disagreed with that offset would
 * either overlap it or leave a stripe.
 */
export const TITLE_BAR_PX = IS_MACOS ? 36 : 32;
