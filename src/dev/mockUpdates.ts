/**
 * A fake update, for `npm run dev`.
 *
 * The real thing needs a signed release on GitHub and a rebuilt binary to
 * update *from*, so none of it is reachable in a browser tab -- and the seven
 * states it moves through are exactly the part worth iterating on. This walks
 * them on a timer instead.
 *
 * Loaded through the same dynamic `import()` as `mockData`, so it never ships
 * in a production bundle.
 *
 * `?update=fail` and `?update=uptodate` reach the two stages you can't get to
 * by pressing the buttons in order, and `?update=manual` is the build that
 * can't replace itself -- macOS until it's signed, or a `.deb`/`.rpm`.
 */
import type { UpdateState } from "../types";

const MOCK_CURRENT = "0.6.0-dev";
const MOCK_NEXT = "0.6.1";
const MOCK_TOTAL = 48 * 1024 * 1024;

/** `fail`, `uptodate`, or the default walk through to a finished install. */
function mode(): string | null {
  return new URLSearchParams(window.location.search).get("update");
}

function shouldFail(): boolean {
  return mode() === "fail";
}

function resting(stage: UpdateState["stage"]): UpdateState {
  return {
    stage,
    currentVersion: MOCK_CURRENT,
    version: null,
    notes: null,
    downloaded: 0,
    total: null,
    error: null,
    canInstall: true,
  };
}

export function mockUpdateState(): UpdateState {
  return resting("idle");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves the way the real check does: to a state, never to an error. */
export async function mockCheck(): Promise<UpdateState> {
  await wait(600);
  if (shouldFail()) {
    return { ...resting("failed"), error: "Couldn't check" };
  }
  if (mode() === "uptodate") {
    return resting("upToDate");
  }
  return {
    ...resting("available"),
    canInstall: mode() !== "manual",
    version: MOCK_NEXT,
    notes: "- Emote combos stack again\n- Fixed the tab bar flickering on hover",
  };
}

/**
 * Ticks progress the way the real download does, through the same callback
 * the event listener drives, then lands on `ready`.
 */
export async function mockInstall(onState: (state: UpdateState) => void): Promise<void> {
  const base = { ...resting("downloading"), version: MOCK_NEXT, total: MOCK_TOTAL };
  for (let step = 1; step <= 20; step += 1) {
    await wait(150);
    if (shouldFail() && step === 8) {
      onState({ ...resting("failed"), error: "Couldn't install" });
      return;
    }
    onState({ ...base, downloaded: Math.round((MOCK_TOTAL * step) / 20) });
  }
  onState({ ...resting("ready"), version: MOCK_NEXT });
}
