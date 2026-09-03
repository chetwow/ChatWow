import { error as logError, warn as logWarn } from "@tauri-apps/plugin-log";

import { IS_TAURI } from "./tauri";

/**
 * Send what the webview couldn't handle to the file Rust writes to.
 *
 * Half of this app is a web page, and until this existed an exception in it
 * left no trace anywhere: the devtools console nobody had open, and then a
 * blank pane or a control that quietly stopped working. These two listeners
 * are the whole net -- React 19 reports an uncaught render error through
 * `reportError`, which arrives here as an ordinary `error` event, so a broken
 * component lands in the log alongside whatever Rust was doing at the time.
 *
 * Everything worth reading goes in the message text. The bracketed source the
 * plugin stamps on each line is derived from *our* stack at the point of the
 * call, so it names this file however it's arranged -- it can't be made to
 * point at whatever actually threw.
 *
 * Outside Tauri (`npm run dev`) there's no backend to write to and the
 * browser's own console is right there, so this does nothing.
 */
export function installDiagnostics() {
  if (!IS_TAURI) return;

  window.addEventListener("error", (event) => {
    // An `error` event on a failed <img> or <script> is a plain Event with no
    // `error` on it -- a CDN emote 404ing is not a bug report.
    if (!(event instanceof ErrorEvent)) return;
    const at = origin(event);
    const detail = describe(event.error, event.message);
    void send(logError, at ? `uncaught error at ${at}: ${detail}` : `uncaught error: ${detail}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    // A rejected promise nobody caught. Warn rather than error: a good many
    // are an aborted fetch on a tab that closed under it.
    void send(logWarn, `unhandled rejection: ${describe(event.reason)}`);
  });
}

/** `file:line:column`, when the event carried one. */
function origin(event: ErrorEvent): string | undefined {
  if (!event.filename) return undefined;
  return `${event.filename}:${event.lineno}:${event.colno}`;
}

/**
 * A thrown value as a message and, where there is one, its stack.
 *
 * The two halves are joined here rather than left to `stack` because the
 * engines disagree about what that holds: V8 (the WebView2 and WebKitGTK
 * builds) starts it with `Error: message`, JavaScriptCore (macOS) gives the
 * frames alone. Reading `stack` and trusting it therefore drops the message
 * entirely on macOS -- which is how this was first written, and what a run
 * against the real webview caught.
 *
 * It also can't assume an `Error` at all: JavaScript lets anything be thrown,
 * and a bare string from a library is exactly the case where the message is
 * the only thing there is.
 */
function describe(thrown: unknown, fallback?: string): string {
  if (thrown instanceof Error) {
    const head = `${thrown.name}: ${thrown.message}`;
    const stack = thrown.stack;
    if (!stack) return head;
    return stack.startsWith(thrown.name) ? stack : `${head}\n${stack}`;
  }
  if (thrown === undefined || thrown === null) return fallback ?? "unknown error";
  return typeof thrown === "string" ? thrown : safeStringify(thrown, fallback);
}

function safeStringify(value: unknown, fallback?: string): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular, or something with a throwing `toJSON`.
    return fallback ?? String(value);
  }
}

/**
 * Hand one line to the backend, and swallow anything that goes wrong doing
 * it. A logger that can throw inside an error handler turns one broken thing
 * into a loop, and there is nowhere left to report that to anyway.
 */
async function send(write: (message: string) => Promise<void>, message: string) {
  try {
    await write(message);
  } catch {
    // Nothing to do: the backend is the only place this could have gone.
  }
}
