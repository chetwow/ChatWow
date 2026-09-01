import { Fragment, memo, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmoteImage } from "./EmoteImage";
import { useTooltip } from "../store/tooltip";
import { useChat } from "../store/chat";
import { mentionsYou } from "../lib/mentions";
import { isBlacklisted } from "../lib/emoteBlacklist";
import type { Badge, ReplyInfo, Segment, StoredMessage } from "../types";

function timeOf(ts: number) {
  if (!ts) return "";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function BadgeView({ badge }: { badge: Badge }) {
  if (!badge.url) {
    // No art available (signed out) -- fall back to a compact text chip.
    return (
      <span
        title={badge.title}
        className="mr-1 rounded-[3px] bg-line px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-dim"
      >
        {badge.title.slice(0, 3)}
      </span>
    );
  }
  return (
    <img
      src={badge.url}
      alt={badge.title}
      title={badge.title}
      loading="lazy"
      className="mr-1 inline-block h-[18px] w-[18px] rounded-[3px] align-middle"
    />
  );
}

/**
 * What a right-click landed on, read back off the data attributes below rather
 * than threaded down as a prop -- `MessageRow` is memoized, and the row's own
 * context-menu handler already gets the event that reached the emote.
 */
export type EmoteTarget = { id: string; name: string; provider: string; hidden: boolean };

/** The emote under a context-menu event, or null if the click missed one. */
export function emoteAt(target: EventTarget | null): EmoteTarget | null {
  const element = (target as Element | null)?.closest?.("[data-emote-name]");
  if (!(element instanceof HTMLElement)) return null;
  const { emoteId = "", emoteName, emoteProvider = "" } = element.dataset;
  if (emoteName === undefined) return null;
  return {
    id: emoteId,
    name: emoteName,
    provider: emoteProvider,
    hidden: element.dataset.emoteHidden === "true",
  };
}

/**
 * A blacklisted emote: its name as underlined text, hovering into the same
 * preview the image would have shown. The underline is what marks the word as
 * an emote you've hidden rather than something a chatter actually typed as
 * plain text.
 */
function HiddenEmote({
  id,
  name,
  provider,
  urlLarge,
}: {
  id: string;
  name: string;
  provider: string;
  urlLarge: string;
}) {
  const show = useTooltip((s) => s.show);
  const hide = useTooltip((s) => s.hide);

  return (
    <span
      data-emote-id={id}
      data-emote-name={name}
      data-emote-provider={provider}
      data-emote-hidden="true"
      className="cursor-default underline decoration-ink-faint decoration-dotted underline-offset-2"
      onMouseEnter={(event) =>
        show({ name, urlLarge, provider }, event.currentTarget.getBoundingClientRect())
      }
      onMouseLeave={hide}
    >
      {name}
    </span>
  );
}

function EmoteView({ segment }: { segment: Extract<Segment, { kind: "emote" }> }) {
  const show = useTooltip((s) => s.show);
  const hide = useTooltip((s) => s.hide);
  // Subscribed here rather than passed down through the row: `MessageRow` is
  // memoized on message identity, so a prop would never reach a message that's
  // already on screen. A store subscription re-renders this component directly,
  // which is what lets blacklisting from the context menu repaint the backlog.
  const blacklist = useChat((state) => state.preferences.emoteBlacklist);

  const hidden = isBlacklisted(segment, blacklist);
  // Overlays have no room of their own -- they're stacked on the base -- so
  // hiding the base hides the whole combo. Each part falls back to its own
  // name, which is the space-separated text that was typed before
  // `fold_overlays` merged them.
  const hiddenOverlays = hidden
    ? segment.overlays
    : segment.overlays.filter((overlay) => isBlacklisted(overlay, blacklist));

  const trailing = hiddenOverlays.map((overlay) => (
    <Fragment key={`${overlay.provider}-${overlay.id}`}>
      {" "}
      <HiddenEmote
        id={overlay.id}
        name={overlay.name}
        provider={overlay.provider}
        urlLarge={overlay.url}
      />
    </Fragment>
  ));

  if (hidden) {
    return (
      <>
        <HiddenEmote
          id={segment.id}
          name={segment.name}
          provider={segment.provider}
          urlLarge={segment.url_large}
        />
        {trailing}
      </>
    );
  }

  return (
    <>
      <span
        data-emote-id={segment.id}
        data-emote-name={segment.name}
        data-emote-provider={segment.provider}
        className="relative mx-[1px] inline-block align-middle"
        onMouseEnter={(event) =>
          show(
            { name: segment.name, urlLarge: segment.url_large, provider: segment.provider },
            event.currentTarget.getBoundingClientRect(),
          )
        }
        onMouseLeave={hide}
      >
        <EmoteImage
          id={segment.id}
          provider={segment.provider}
          url={segment.url}
          name={segment.name}
          className="inline-block h-7 max-w-none align-middle"
        />
        {segment.overlays
          .filter((overlay) => !isBlacklisted(overlay, blacklist))
          .map((overlay) => (
            <EmoteImage
              key={overlay.name}
              id={overlay.id}
              provider={overlay.provider}
              url={overlay.url}
              name={overlay.name}
              className="pointer-events-none absolute left-1/2 top-1/2 h-7 max-w-none -translate-x-1/2 -translate-y-1/2"
            />
          ))}
      </span>
      {trailing}
    </>
  );
}

function ReplyQuote({ replyTo, highlighted }: { replyTo: ReplyInfo; highlighted: boolean }) {
  return (
    <div
      className={[
        "mb-[2px] flex min-w-0 items-center gap-1.5 text-[11px]",
        highlighted ? "text-rose-300/90" : "text-ink-faint",
      ].join(" ")}
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="shrink-0"
      >
        <path d="M6 3 2.5 6.5 6 10" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2.5 6.5H10a3 3 0 0 1 3 3V11" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="min-w-0 flex-1 truncate">
        Replying to <span className="font-semibold">{replyTo.displayName}</span>
        <span className="opacity-70">: {replyTo.body}</span>
      </span>
      {highlighted && (
        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-rose-400/80">
          Replying to you
        </span>
      )}
    </div>
  );
}

function SegmentView({ segment }: { segment: Segment }) {
  switch (segment.kind) {
    case "text":
      return <>{segment.text}</>;
    case "emote":
      return <EmoteView segment={segment} />;
    case "mention":
      return (
        <span className="rounded bg-accent/15 px-1 font-semibold text-accent">
          {segment.text}
        </span>
      );
    case "link":
      return (
        <button
          onClick={() => void openUrl(segment.href)}
          className="cursor-pointer text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {segment.text}
        </button>
      );
  }
}

function MessageRowInner({
  message,
  onContextMenu,
}: {
  message: StoredMessage;
  onContextMenu?: (event: MouseEvent, message: StoredMessage) => void;
}) {
  const time = timeOf(message.ts);
  const myLogin = useChat((state) => state.auth.login);
  // Read from the store rather than passed down: this component is memoized on
  // message identity, and the messages already on screen are immutable, so a
  // prop would never reach a row that's already rendered. Same reason
  // `EmoteView` subscribes to the blacklist itself.
  const italicActions = useChat((state) => state.preferences.italicActions);
  const showTimestamps = useChat((state) => state.preferences.showTimestamps);
  const isReplyToYou = Boolean(
    message.replyTo && myLogin && message.replyTo.login.toLowerCase() === myLogin.toLowerCase(),
  );
  // Being named reads the same as being replied to -- both are chat talking to
  // you -- so they share one highlight rather than competing for the row.
  const aboutYou = isReplyToYou || mentionsYou(message, myLogin);
  const handleContextMenu = onContextMenu
    ? (event: MouseEvent) => {
        event.preventDefault();
        onContextMenu(event, message);
      }
    : undefined;

  if (message.kind === "notice") {
    return (
      <div
        onContextMenu={handleContextMenu}
        className="msg-row px-1.5 py-[3px] text-ink-faint italic"
      >
        {message.systemMessage}
      </div>
    );
  }

  const body = (
    <span className={message.deleted ? "line-through" : undefined}>
      {message.segments.map((segment, index) => (
        <SegmentView key={index} segment={segment} />
      ))}
    </span>
  );

  return (
    <div
      onContextMenu={handleContextMenu}
      className={[
        "msg-row rise group relative flex gap-1.5 px-1.5 py-[3px] leading-[1.45] hover:bg-surface-hover",
        message.deleted ? "opacity-40" : "",
        message.kind === "system" ? "border-l-2 border-accent bg-accent/[0.07]" : "",
        message.kind === "whisper" ? "border-l-2 border-fuchsia-400/70 bg-fuchsia-400/[0.06]" : "",
        message.isFirstMessage ? "border-l-2 border-emerald-400/70 bg-emerald-400/[0.05]" : "",
        aboutYou ? "border-l-2 border-rose-400/70 bg-rose-400/[0.06]" : "",
      ].join(" ")}
    >
      {/* Dropped entirely rather than blanked, so the row reclaims the gutter
          instead of keeping an empty column of it. */}
      {showTimestamps && (
        <span className="w-8 shrink-0 pt-[1px] text-right text-[10px] tabular-nums text-ink-faint">
          {time}
        </span>
      )}

      <div className="selectable min-w-0 flex-1 break-words">
        {message.replyTo && <ReplyQuote replyTo={message.replyTo} highlighted={isReplyToYou} />}

        {message.systemMessage && (
          <div className="mb-[2px] text-[12px] text-accent">{message.systemMessage}</div>
        )}

        {message.segments.length > 0 || message.kind === "chat" ? (
          <>
            {message.kind === "whisper" && (
              // Whispers land in whichever channel you're reading, so the row
              // has to say what it is -- otherwise it reads as someone in this
              // channel talking.
              <span className="mr-1 rounded bg-fuchsia-400/20 px-1 align-[1px] text-[10px] font-semibold uppercase tracking-wide text-fuchsia-200">
                whisper
              </span>
            )}
            {message.badges.map((badge) => (
              <BadgeView key={badge.id} badge={badge} />
            ))}
            <span className="font-semibold" style={{ color: message.color }}>
              {message.displayName}
            </span>
            {message.isAction ? (
              // Still the sender's color and still without the colon -- that's
              // what makes it an action. Only the slant is optional.
              <span
                className={italicActions ? "italic" : undefined}
                style={{ color: message.color }}
              >
                {" "}
                {body}
              </span>
            ) : (
              <>
                <span className="text-ink-faint">: </span>
                {body}
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Messages are immutable once stored (deletion swaps the object), so memoizing
 * on identity keeps a busy channel from re-rendering its whole backlog.
 */
export const MessageRow = memo(MessageRowInner);
