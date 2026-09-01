/**
 * The mention ping, synthesized rather than shipped as an audio file: it's two
 * short sine tones, so generating them keeps a binary asset out of the repo and
 * out of the bundle, and there's nothing to fetch before the first one plays.
 */

let context: AudioContext | null = null;
let lastPlayed = 0;

/** A burst of mentions -- one batch, or a spammed name -- pings once. */
const MIN_GAP_MS = 1500;

/** Rising two-note blip: pitch in Hz, offset in seconds from the start. */
const TONES = [
  { frequency: 880, at: 0 },
  { frequency: 1320, at: 0.09 },
];

export function playMentionSound(now = Date.now()) {
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;

  try {
    context ??= new AudioContext();
    // Browsers hold a context suspended until the page has been interacted
    // with; resuming is a no-op once it's already running.
    void context.resume();

    for (const tone of TONES) {
      const start = context.currentTime + tone.at;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = tone.frequency;

      // Ramped, not switched on: a square edge on the gain is what makes a
      // synthesized blip click. Exponential ramps can't reach 0, hence the
      // near-silent floor at either end.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    }
  } catch {
    // No audio device, or the context wouldn't start -- a missing ping
    // shouldn't take the batch of messages down with it.
  }
}
