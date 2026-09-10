import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TEXT_TOOLTIP_STYLE, textTooltipPosition } from "../lib/textTooltip";

/** One delegated tooltip for text hints, including disabled controls and dynamic chat badges. */
export function TextTooltip() {
  const [source, setSource] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const text = source?.dataset.tooltip;

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
        if (element.isConnected && element.getClientRects().length) setSource(element);
      };
      if (immediate) reveal();
      else timer = setTimeout(reveal, 400);
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
    if (!source || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    setPosition(textTooltipPosition(source.getBoundingClientRect(), rect.width, rect.height, window.innerWidth, window.innerHeight));
    const describedBy = source.getAttribute("aria-describedby");
    source.setAttribute("aria-describedby", [describedBy, id].filter(Boolean).join(" "));
    // A control or message can disappear without a pointerout event.
    const observer = new MutationObserver(() => {
      if (!source.isConnected || !source.getClientRects().length || source.dataset.tooltip !== text) setSource(null);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tooltip", "hidden", "class", "style"] });
    return () => {
      observer.disconnect();
      const remaining = (source.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value && value !== id).join(" ");
      if (remaining) source.setAttribute("aria-describedby", remaining);
      else source.removeAttribute("aria-describedby");
    };
  }, [source, text, id]);

  return source && text ? createPortal(
    <div ref={popup} id={id} role="tooltip" style={position}
      className={`pointer-events-none fixed z-[100] max-h-[calc(100vh-16px)] w-max max-w-[min(260px,calc(100vw-16px))] overflow-hidden break-words whitespace-pre-wrap ${TEXT_TOOLTIP_STYLE}`}>
      {text}
    </div>, document.body,
  ) : null;
}
