import { useEffect, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { useChat } from "../store/chat";
import { useTooltip } from "../store/tooltip";
import { twitchClip } from "../lib/twitchClips";
import { openLink, youtubeVideo } from "../lib/youtube";

/** One menu for chat links and ordinary anchors, including links in dialogs and logs. */
export function LinkContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; href: string } | null>(null);
  const inlineYoutube = useChat((state) => state.preferences.inlineYoutube);
  const inlineTwitchClips = useChat((state) => state.preferences.inlineTwitchClips);
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest("[data-link-href], a[href]") : null;
      const href = element?.getAttribute("data-link-href") ?? element?.getAttribute("href");
      if (element?.closest("[data-message-menu]")) return;
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      useTooltip.getState().hide();
      setMenu({ x: event.clientX, y: event.clientY, href });
    };
    window.addEventListener("contextmenu", listener, true);
    return () => window.removeEventListener("contextmenu", listener, true);
  }, []);
  return menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} options={[
    { label: "Copy link address", onSelect: () => { void navigator.clipboard.writeText(menu.href); } },
    ...(((inlineYoutube && youtubeVideo(menu.href)) || (inlineTwitchClips && twitchClip(menu.href))) ? [{ label: "Open in browser", onSelect: () => { void openLink(menu.href); } }] : []),
  ]} />;
}
