import { Fragment, useEffect } from "react";
import { TITLE_BAR_PX } from "../lib/tauri";
import type { ReleaseNotes } from "../lib/releaseNotes";

/** Render the one inline Markdown convention the changelog currently uses. */
function NoteText({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code
        key={index}
        className="rounded bg-black/25 px-1 py-px font-mono text-[0.92em] text-ink"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/** The current build's own changelog section, shown once after an upgrade. */
export function WhatsNewDialog({ notes, onClose }: { notes: ReleaseNotes; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      data-modal
      style={{ top: TITLE_BAR_PX }}
      className="fixed inset-x-0 bottom-0 z-[80] flex items-center justify-center bg-black/65 p-3 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[min(620px,calc(100%-1.5rem))] w-[min(520px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-xl text-accent">
            ✦
          </span>
          <div className="min-w-0">
            <h2 id="whats-new-title" className="text-[16px] font-semibold text-ink">
              What’s new in ChatWow
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-faint">Version {notes.version}</p>
          </div>
        </div>

        <div className="scroller min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="flex flex-col gap-5">
            {notes.sections.map((section) => (
              <section key={section.title}>
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
                  {section.title}
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {section.items.map((item, index) => (
                    <li
                      key={`${index}-${item}`}
                      className="flex gap-2.5 text-[12px] leading-relaxed text-ink-dim"
                    >
                      <span aria-hidden className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                      <span className="selectable min-w-0">
                        <NoteText text={item} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-line px-4 py-3">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent/85"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
