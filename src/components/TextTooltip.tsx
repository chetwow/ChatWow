import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTooltipFade } from "../lib/useTooltipFade";
import { TOOLTIP_FADE_STYLE } from "../lib/tooltipFade";
import { TEXT_TOOLTIP_STYLE, textTooltipDelay, textTooltipPosition } from "../lib/textTooltip";

/** One delegated tooltip for text hints, including disabled controls and dynamic chat badges. */
export function TextTooltip() {
  const [source, setSource] = useState<{ element: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const { rendered, visible } = useTooltipFade(source);

  useEffect(() => {
    let pending: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const find = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>("[data-tooltip]") : null;
    const hide = () => {
      clearTimeout(timer);
      pending = null;
      setSource(null);
    };
    const show = (element: HTMLElement | null, immediate = false) => {
      if (!element?.dataset.tooltip) { hide(); return; }
      if (element === pending) return;
      hide();
      pending = element;
      const reveal = () => {
        if (element.isConnected && element.getClientRects().length) setSource({ element, text: element.dataset.tooltip! });
      };
      if (immediate) reveal();
      else timer = setTimeout(reveal, textTooltipDelay(element.closest<HTMLElement>("[data-tooltip-delay]")?.dataset.tooltipDelay));
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType !== "touch") show(find(event.target));
    };
    const out = (event: PointerEvent) => {
      if (find(event.relatedTarget) !== pending) hide();
    };
    const focus = (event: FocusEvent) => show(find(event.target), true);
    const scroll = (event: Event) => {
      if (event.target === document || (event.target instanceof Element && pending && event.target.contains(pending))) hide();
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!rendered || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    setPosition(textTooltipPosition(rendered.element.getBoundingClientRect(), rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [rendered]);

  useLayoutEffect(() => {
    if (!source) return;
    const { element, text } = source;
    const describedBy = element.getAttribute("aria-describedby");
    element.setAttribute("aria-describedby", [describedBy, id].filter(Boolean).join(" "));
    // A control or message can disappear without a pointerout event.
    const observer = new MutationObserver(() => {
      if (!element.isConnected || !element.getClientRects().length || element.dataset.tooltip !== text) setSource(null);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tooltip", "hidden", "class", "style"] });
    return () => {
      observer.disconnect();
      const remaining = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value && value !== id).join(" ");
      if (remaining) element.setAttribute("aria-describedby", remaining);
      else element.removeAttribute("aria-describedby");
    };
  }, [source, id]);

  return rendered ? createPortal(
    <div ref={popup} id={id} role="tooltip" aria-hidden={!source} style={{ ...position, opacity: visible ? 1 : 0 }}
      className={`pointer-events-none fixed z-[100] max-h-[calc(100vh-16px)] w-max max-w-[min(260px,calc(100vw-16px))] overflow-hidden break-words whitespace-pre-wrap ${TEXT_TOOLTIP_STYLE} ${TOOLTIP_FADE_STYLE}`}>
      {rendered.text}
    </div>, document.querySelector("[data-theme]") ?? document.body,
  ) : null;
}
