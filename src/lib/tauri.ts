import { isTauri } from "@tauri-apps/api/core";

/**
 * True inside the real app, false when the same Vite build is opened directly
 * in a browser (`npm run dev`, no `tauri dev`). Lets the store fall back to
 * mock data instead of failing every `invoke` call, so UI work doesn't pay
 * for a Rust rebuild on every change.
 */
export const IS_TAURI = isTauri();
