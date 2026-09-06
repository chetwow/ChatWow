import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useChat } from "../store/chat";
import type { MessageEffect } from "../types";
import "./messageEffects.css";

// One observer for the complete backlog. Effects outside the viewport or in
// a hidden window keep their frame but stop animating; the final unmount
// disconnects both listeners. No per-frame JavaScript or chat-store writes.
const tracked = new Map<Element, { visible: boolean; update: (running: boolean) => void }>();
let observer: IntersectionObserver | undefined;
const updateVisibility = () => {
  for (const entry of tracked.values()) entry.update(entry.visible && !document.hidden);
};

function observeEffect(element: Element, update: (running: boolean) => void) {
  if (tracked.size === 0) {
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const state = tracked.get(entry.target);
          if (state) {
            state.visible = entry.isIntersecting;
            state.update(state.visible && !document.hidden);
          }
        }
      });
    }
    document.addEventListener("visibilitychange", updateVisibility);
  }
  tracked.set(element, { visible: !observer, update });
  update(!observer && !document.hidden);
  observer?.observe(element);
  return () => {
    observer?.unobserve(element);
    tracked.delete(element);
    if (!tracked.size) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", updateVisibility);
    }
  };
}

// Fixed choreography keeps rerenders stable. Staggered starts, differing
// heights and sideways drift make a continuous party instead of a wave of
// identical icons. Each tuple is x%, size, seconds, phase, lift, drift, spin.
const PARTICLES = [
  [7, 32, 1.2, -0.55, 87, 13, -32], [19, 30, 1.45, -1.05, 103, -17, 42],
  [33, 28, 1.1, -0.15, 80, 18, 62], [46, 31, 1.55, -0.9, 100, -13, -48],
  [59, 34, 1.3, -0.35, 92, 17, 35], [73, 29, 1.15, -0.7, 83, -21, -56],
  [86, 26, 1.4, -1.2, 107, 12, 66], [94, 32, 1.6, -0.25, 89, -18, -40],
  [13, 25, 1.65, -0.05, 80, -13, 45], [38, 32, 1.35, -1.1, 97, 22, -65],
  [65, 28, 1.75, -0.85, 86, -19, 40], [81, 30, 1.5, -0.45, 100, 16, -35],
];

function AnimatedFrame({ effect, children }: { effect: MessageEffect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (ref.current) return observeEffect(ref.current, setRunning);
  }, []);

  return (
    <div ref={ref} className={`message-effect message-effect--${effect.kind}`}
      data-message-effect={effect.kind} data-running={running}>
      <div className="message-effect__art" aria-hidden="true">
        {effect.kind === "cosmic-abyss" && <div className="effect-clouds" />}
        {effect.kind === "rainbow-eclipse" && <div className="effect-rainbow" />}
        {effect.kind === "emote-party" && effect.emotes.length > 0 && (
          <div className="effect-party">
            {PARTICLES.map(([x, size, duration, phase, lift, drift, spin], index) => {
              const emote = effect.emotes[index % effect.emotes.length];
              return (
                <span key={index} className="effect-party__particle" style={{
                  left: `${x}%`, width: size, height: size,
                  "--duration": `${duration}s`, "--phase": `${phase}s`,
                  "--lift": `${-lift}px`, "--drift": `${drift}px`, "--spin": `${spin}deg`,
                  "--rest-y": `${-38 - (index % 3) * 13}px`,
                } as CSSProperties}>
                  <img src={emote.url} alt="" data-effect-emote={emote.name}
                    loading="lazy" decoding="async" draggable={false}
                    onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="message-effect__content">{children}</div>
    </div>
  );
}

export function MessageEffectFrame({ effect, disabled, children }: {
  effect: MessageEffect;
  disabled?: boolean;
  children: ReactNode;
}) {
  // Rows are immutable and memoized; this subscription repaints held messages
  // when settings or a message's context menu changes the global toggle.
  const enabled = useChat((state) => state.preferences.enableMessageEffects);
  return enabled && !disabled ? <AnimatedFrame effect={effect}>{children}</AnimatedFrame> : <>{children}</>;
}
