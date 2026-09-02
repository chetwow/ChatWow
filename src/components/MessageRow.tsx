import { Fragment, memo, useEffect, useRef, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmoteImage } from "./EmoteImage";
import { useTooltip } from "../store/tooltip";
import { loginOf, useChat } from "../store/chat";
import { isAboutYou, repliesToYou } from "../lib/mentions";
import { mentionIgnored, userBlocked } from "../lib/ignores";
import { isBlacklisted } from "../lib/emoteBlacklist";
import { providerEnabled } from "../lib/emoteProviders";
import { imagePreviewUrl, linkHost, linkKind, type LinkKind } from "../lib/links";
import { messageTime } from "../lib/messageText";
import { cachedLinkPreview, loadLinkPreview } from "../lib/linkPreviews";
import type { Badge, LinkPreview, ReplyInfo, Segment, StoredMessage } from "../types";

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
        show({ kind: "emote", name, urlLarge, provider }, event.currentTarget.getBoundingClientRect())
      }
      onMouseLeave={hide}
    >
      {name}
    </span>
  );
}

/**
 * The 7TV badge its owner has equipped, if we know it yet.
 *
 * Subscribed here rather than read off the message: badges are resolved after
 * the message that prompted the lookup arrives, and stored messages are
 * immutable -- a row that already rendered would never get one. Reading the
 * value (rather than the whole map) keeps this to one re-render, when *this*
 * chatter's badge lands.
 */
function SevenTvBadge({ userId }: { userId: string }) {
  const badge = useChat((state) =>
    state.preferences.showSeventvBadges ? state.seventvBadges[userId] : undefined,
  );
  return badge ? <BadgeView badge={badge} /> : null;
}

function EmoteView({ segment }: { segment: Extract<Segment, { kind: "emote" }> }) {
  const show = useTooltip((s) => s.show);
  const hide = useTooltip((s) => s.hide);
  // Subscribed here rather than passed down through the row: `MessageRow` is
  // memoized on message identity, so a prop would never reach a message that's
  // already on screen. A store subscription re-renders this component directly,
  // which is what lets blacklisting from the context menu repaint the backlog.
  const blacklist = useChat((state) => state.preferences.emoteBlacklist);
  const seventv = useChat((state) => state.preferences.enableSeventv);
  const bttv = useChat((state) => state.preferences.enableBttv);
  const ffz = useChat((state) => state.preferences.enableFfz);

  // A provider you've switched off isn't a hidden emote, it's an absent one:
  // the word renders as the chatter typed it, with no underline and no
  // preview behind it, exactly as it would if the emote had never existed.
  const off = (emote: { provider: string }) =>
    !providerEnabled(emote.provider, { seventv, bttv, ffz });
  if (off(segment)) {
    return <>{[segment.name, ...segment.overlays.map((overlay) => overlay.name)].join(" ")}</>;
  }

  const hidden = isBlacklisted(segment, blacklist);
  // Overlays have no room of their own -- they're stacked on the base -- so
  // hiding the base hides the whole combo. Each part falls back to its own
  // name, which is the space-separated text that was typed before
  // `fold_overlays` merged them.
  const offOverlays = segment.overlays.filter(off);
  const hiddenOverlays = hidden
    ? segment.overlays.filter((overlay) => !off(overlay))
    : segment.overlays.filter((overlay) => !off(overlay) && isBlacklisted(overlay, blacklist));

  const trailing = [
    ...offOverlays.map((overlay) => (
      <Fragment key={`off-${overlay.provider}-${overlay.id}`}> {overlay.name}</Fragment>
    )),
    ...hiddenOverlays.map((overlay) => (
      <Fragment key={`${overlay.provider}-${overlay.id}`}>
        {" "}
        <HiddenEmote
          id={overlay.id}
          name={overlay.name}
          provider={overlay.provider}
          urlLarge={overlay.url}
        />
      </Fragment>
    )),
  ];

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
            {
              kind: "emote",
              name: segment.name,
              urlLarge: segment.url_large,
              provider: segment.provider,
            },
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
          .filter((overlay) => !off(overlay) && !isBlacklisted(overlay, blacklist))
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

/**
 * Just the text of a message, with its emotes and links. Split out so the user
 * card's log of someone's messages renders them exactly as chat does, rather
 * than flattening a `PagChomp` back into six letters.
 */
export function MessageBody({ message }: { message: StoredMessage }) {
  return (
    <span className={message.deleted ? "line-through" : undefined}>
      {message.segments.map((segment, index) => (
        <SegmentView key={index} segment={segment} />
      ))}
    </span>
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
      return <LinkView segment={segment} />;
  }
}

/**
 * A link, and what it turns out to be on hover: the image itself if it points
 * at one, otherwise the title of the page behind it.
 *
 * The wait before either is the point rather than polish. A preview is fetched
 * from wherever the link points, so a mouse crossing a message on its way
 * somewhere else shouldn't announce the reader to a host a stranger chose.
 */
const PREVIEW_DELAY_MS = 220;

/** The switch each kind of link answers to. */
const PREFERENCE = {
  image: "previewImages",
  // A 7TV emote link previews as a picture, so it answers to the picture
  // switch -- even though, unlike an image url, it takes a fetch to resolve.
  emote: "previewImages",
  page: "previewPages",
} as const satisfies Record<LinkKind, string>;

function LinkView({ segment }: { segment: Extract<Segment, { kind: "link" }> }) {
  const show = useTooltip((s) => s.show);
  const hide = useTooltip((s) => s.hide);
  // Which switch applies is decided by the link, not by what comes back --
  // the switch has to be read before anything is asked. Subscribed here rather
  // than passed down, for the reason `EmoteView` gives: rows are memoized on
  // message identity and the messages already on screen are immutable, so
  // flipping one has to reach them through the store.
  const kind = linkKind(segment.href);
  const enabled = useChat((state) => state.preferences[PREFERENCE[kind]]);
  const image = kind === "image" ? imagePreviewUrl(segment.href) : null;
  const timer = useRef<number | undefined>(undefined);
  /**
   * Bumped every time the pointer leaves. A title arrives whenever the host
   * answers, which may be long after that -- and a preview that appears over
   * chat you're no longer pointing at is worse than none.
   */
  const hover = useRef(0);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    hover.current += 1;
  };
  // A row trimmed out of the backlog mid-hover would otherwise fire into
  // nothing and leave the preview up.
  useEffect(() => cancel, []);

  const preview = (element: HTMLElement) => {
    const anchor = () => element.getBoundingClientRect();
    if (image) return show({ kind: "image", url: image }, anchor());

    // A resolved emote is drawn as the emote it is -- image, name, who by --
    // rather than as a card about a web page. `description` is the owner; see
    // `seventv_links` in Rust, which fills it in.
    const found = (preview: LinkPreview) =>
      kind === "emote"
        ? ({
            kind: "emote",
            name: preview.title,
            urlLarge: preview.image,
            provider: "7tv",
            by: preview.description,
          } as const)
        : ({ kind: "page", preview, host: linkHost(segment.href) } as const);

    const known = cachedLinkPreview(segment.href);
    if (known !== undefined) {
      // Asked before: draw it or don't, with no spinner in between.
      return known ? show(found(known), anchor()) : undefined;
    }

    // The spinner goes up before the request, so the wait is visibly a wait.
    show({ kind: "loading" }, anchor());
    const token = hover.current;
    void loadLinkPreview(segment.href).then((preview) => {
      if (hover.current !== token) return;
      if (!preview) return hide();
      show(found(preview), anchor());
    });
  };

  return (
    <button
      onClick={() => void openUrl(segment.href)}
      onMouseEnter={
        enabled
          ? (event) => {
              const element = event.currentTarget;
              window.clearTimeout(timer.current);
              // Measured when it fires, not now: chat may have scrolled under
              // the pointer in between.
              timer.current = window.setTimeout(() => preview(element), PREVIEW_DELAY_MS);
            }
          : undefined
      }
      onMouseLeave={
        enabled
          ? () => {
              cancel();
              hide();
            }
          : undefined
      }
      // `anywhere` rather than the row's inherited `break-word`: a button is an
      // atomic inline box, so it's laid out at its own intrinsic width, and
      // `break-word` doesn't shrink that -- a url with nothing to break on
      // (no hyphen, no slash in the right place) stretched the row past the
      // pane and was cut off. `anywhere` is the one that counts a forced break
      // when measuring, so the button can be as narrow as the pane.
      // `text-left` because a button centres its text, which only shows once
      // there is more than one line of it.
      className="cursor-pointer text-left text-accent underline decoration-accent/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent"
    >
      {segment.text}
    </button>
  );
}

function MessageRowInner({
  message,
  onContextMenu,
  onNameClick,
  onChannelClick,
}: {
  message: StoredMessage;
  onContextMenu?: (event: MouseEvent, message: StoredMessage) => void;
  onNameClick?: (event: MouseEvent, message: StoredMessage) => void;
  /**
   * Given only where rows from several channels are mixed together -- the
   * mentions tab. Its presence is what draws the channel chip, since in a
   * channel's own view the chip would say the same thing on every row.
   */
  onChannelClick?: (channel: string) => void;
}) {
  const time = messageTime(message.ts);
  // Who "you" are for this row: the account whose connection received it, not
  // the app's -- the same message in the tab beside this one may name nobody.
  const myLogin = useChat((state) => loginOf(state, message.account));
  // Read from the store rather than passed down: this component is memoized on
  // message identity, and the messages already on screen are immutable, so a
  // prop would never reach a row that's already rendered. Same reason
  // `EmoteView` subscribes to the blacklist itself.
  const italicActions = useChat((state) => state.preferences.italicActions);
  const showTimestamps = useChat((state) => state.preferences.showTimestamps);
  // Subscribed here for the same reason the blacklists are: adding a rule has
  // to repaint the messages already on screen, and those are immutable.
  const blockedUsers = useChat((state) => state.preferences.blockedUsers);
  const mentionIgnores = useChat((state) => state.preferences.mentionIgnores);
  const isReplyToYou = repliesToYou(message, myLogin);
  // Being named reads the same as being replied to -- both are chat talking to
  // you -- so they share one highlight rather than competing for the row. The
  // mentions tab collects exactly what this is true of, ignore rules included:
  // a mention you've asked not to hear about shouldn't still be shouting in
  // the one place it does appear.
  const aboutYou = isAboutYou(message, myLogin) && !mentionIgnored(message, mentionIgnores);
  const handleContextMenu = onContextMenu
    ? (event: MouseEvent) => {
        event.preventDefault();
        onContextMenu(event, message);
      }
    : undefined;

  // Without the timestamp column the text would otherwise start hard against
  // the window edge -- and a row with a highlight stripe would have only its
  // 2px border between the two. Both row kinds take the same inset, so they
  // still share a left edge.
  const leftPad = showTimestamps ? "pl-1.5" : "pl-3";

  // Blocked: nothing at all, rather than a "message hidden" placeholder --
  // the point of blocking someone is not to be reminded of them. Unblocking
  // brings the row straight back, since the message is still stored.
  if (userBlocked(message, blockedUsers)) return null;

  if (message.kind === "notice") {
    return (
      <div
        onContextMenu={handleContextMenu}
        className={`msg-row ${leftPad} break-words pr-1.5 py-[3px] text-ink-faint italic`}
      >
        {message.systemMessage}
      </div>
    );
  }

  const body = <MessageBody message={message} />;

  return (
    <div
      onContextMenu={handleContextMenu}
      className={[
        `msg-row rise group relative flex gap-1.5 ${leftPad} pr-1.5 py-[3px] leading-[1.45] hover:bg-surface-hover`,
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
            {/* A whisper's channel is only wherever you happened to be reading
                when it arrived, so labelling it would be inventing a room it
                was said in. The WHISPER chip already says what it is. */}
            {onChannelClick && message.kind !== "whisper" && message.channel && (
              <button
                type="button"
                onClick={() => onChannelClick(message.channel)}
                title={`Go to #${message.channel}`}
                className="mr-1 cursor-pointer rounded bg-line/70 px-1 align-[1px] text-[10px] font-semibold text-ink-faint transition-colors hover:text-ink"
              >
                #{message.channel}
              </button>
            )}
            {message.badges.map((badge) => (
              <BadgeView key={badge.id} badge={badge} />
            ))}
            {message.userId && <SevenTvBadge userId={message.userId} />}
            {onNameClick ? (
              // A button rather than the span it replaces, matching the link
              // segment: both are things inside selectable text that you click.
              <button
                type="button"
                onClick={(event) => onNameClick(event, message)}
                className="cursor-pointer font-semibold hover:underline"
                style={{ color: message.color }}
              >
                {message.displayName}
              </button>
            ) : (
              <span className="font-semibold" style={{ color: message.color }}>
                {message.displayName}
              </span>
            )}
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
