import { useLayoutEffect, useState } from "react";
import { scheduleTooltipFade } from "./tooltipFade";

/** Retain the last tooltip content until its exit transition finishes. */
export function useTooltipFade<T>(value: T | null) {
  const [rendered, setRendered] = useState<T | null>(value);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    if (value !== null) setRendered(value);
    return scheduleTooltipFade(value !== null, setVisible, () => setRendered(null),
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [value]);
  return { rendered, visible };
}
