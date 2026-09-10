import { openAccountSettings } from "../store/settings";
import { windowAnchor } from "../lib/windows";
import { ContextMenu, type ContextMenuOption, type ContextMenuAction } from "./ContextMenu";
import { mentionTabName, paneOf, useChat } from "../store/chat";
import { TAB_AVATAR_MODES } from "../lib/tabAvatar";
import { ANONYMOUS, type TabAvatarMode, type SplitDirection } from "../types";
import { ignoreForChannel } from "../lib/ignores";

/**
 * Which account a tab reads and sends as, picked from every account signed in.
 *
 * Opened by right-clicking the tab. The composer has its own smaller menu.
 * Anonymous is always on
 * the list: a tab that only reads is a legitimate thing to want, and it's the
 * state every tab falls back to when an account is signed out from under it.
 *
 * Changing this keeps the tab and everything already in it. What was said in
 * the channel was said, whoever is reading.
 */
export function AccountMenu({
  tabId,
  x,
  y,
  onOptions,
  onRename,
  onViewPinnedMessage,
  onClose,
}: {
  tabId: string;
  x: number;
  y: number;
  onOptions?: () => void;
  onRename?: () => void;
  onViewPinnedMessage?: () => void;
  onClose: () => void;
}) {
  const accounts = useChat((state) => state.auth.accounts);
  const tab = useChat((state) => state.tabs.find((open) => open.id === tabId));
  const setTabAccount = useChat((state) => state.setTabAccount);
  const requestCloseTab = useChat((state) => state.requestCloseTab);
  const canReopenClosedTab = useChat((state) => state.lastClosedTab !== null);
  const reopenLastClosedTab = useChat((state) => state.reopenLastClosedTab);
  const setMentionsTabNotify = useChat((state) => state.setMentionsTabNotify);
  const setTabAvatarMode = useChat((state) => state.setTabAvatarMode);
  const mentionIgnores = useChat((state) => state.preferences.mentionIgnores);
  const notificationMutes = useChat((state) => state.preferences.notificationMutes);
  const setMentionIgnored = useChat((state) => state.setMentionIgnored);
  const setNotificationMuted = useChat((state) => state.setNotificationMuted);
  if (!tab) return null;
  const channelRule = ignoreForChannel(tab.channel);
  const ignoring = mentionIgnores.includes(channelRule);
  const muted = notificationMutes.includes(channelRule);

  const choose = (account: string): ContextMenuAction => {
    const name =
      account === ANONYMOUS
        ? "Anonymous"
        : (accounts.find((held) => held.id === account)?.login ?? account);
    return {
      // The one it's already on is ticked rather than hidden: the menu answers
      // "who is this tab?" as much as it changes it. The tick trails the name
      // rather than leading it -- a leading one needs a gutter on every other
      // row, and the only space HTML won't collapse into nothing is one no
      // reader can see in the source.
      label: tab.account === account ? `${name} \u2713` : name,
      onSelect: () => void setTabAccount(tabId, account),
    };
  };

  // The tick trails the label here for the same reason it does above.
  const background = (mode: TabAvatarMode, label: string): ContextMenuAction => ({
    label: tab.avatarMode === mode ? `${label} \u2713` : label,
    onSelect: () => void setTabAvatarMode(tabId, mode),
  });

  const tabActions: ContextMenuOption[] = [
    {
      label: "Split",
      submenu: (["right", "left", "up", "down"] as SplitDirection[]).map((direction) => ({
        label: `Split ${direction}`,
        onSelect: () => {
          const state = useChat.getState();
          const pane = paneOf(state, tabId);
          if (pane !== null) state.split(pane, direction, tabId);
        },
      })),
    },
    { label: "Move to new window", onSelect: (event) => void useChat.getState().newWindow(tabId, windowAnchor(event.currentTarget)) },
    { label: "Close tab", onSelect: () => requestCloseTab(tabId) },
    ...(canReopenClosedTab
      ? [
          {
            label: "Reopen closed tab",
            onSelect: () => void reopenLastClosedTab(),
          } satisfies ContextMenuOption,
        ]
      : []),
  ];

  const options: ContextMenuOption[] = tab.kind === "mentions" ? [
    ...(tab.mention && onOptions && onRename
      ? [
          { label: "Options", onSelect: onOptions } satisfies ContextMenuOption,
          { label: "Rename tab", onSelect: onRename } satisfies ContextMenuOption,
          {
            label: "Notifications",
            submenu: [{
              label: tab.mention.notify ? "Notify for matches ✓" : "Notify for matches",
              onSelect: () => void setMentionsTabNotify(tabId, !tab.mention!.notify),
            }],
          } satisfies ContextMenuOption,
          { separator: true } satisfies ContextMenuOption,
        ]
      : []),
    ...tabActions,
  ] : [
    { label: "Active account", submenu: [...accounts.map((account) => choose(account.id)), choose(ANONYMOUS), { separator: true },
      { label: "Add new account...", onSelect: openAccountSettings }] },
    ...(onViewPinnedMessage ? [
      { label: "View pinned message", onSelect: onViewPinnedMessage } satisfies ContextMenuOption,
      { separator: true } satisfies ContextMenuOption,
    ] : []),
    { label: "Notifications", submenu: [{
      label: ignoring ? "Stop ignoring notifications" : "Ignore notifications",
      onSelect: () => setMentionIgnored(channelRule, !ignoring),
    },
    {
      label: muted ? "Unmute notifications" : "Mute notifications",
      onSelect: () => setNotificationMuted(channelRule, !muted),
    }] },
    // What this one tab draws behind its name. The setting only stamps a new
    // tab, so this is the only thing that ever changes an open one -- and
    // there's no "follow the setting" to come back to, because a tab was never
    // following it.
    { label: "Background Avatar", submenu: TAB_AVATAR_MODES.map((mode) => background(mode.id, mode.label)) },
    { separator: true },
    ...tabActions,
  ];

  const name = tab.kind === "mentions" ? mentionTabName(tab) : tab.channel;
  const characters = Array.from(name);
  const title = characters.length > 32 ? `${characters.slice(0, 29).join("")}...` : name;
  return <ContextMenu x={x} y={y} title={title} options={options} onClose={onClose} />;
}
