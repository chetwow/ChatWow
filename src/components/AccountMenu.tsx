import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import { useChat } from "../store/chat";
import { TAB_AVATAR_MODES } from "../lib/tabAvatar";
import { ANONYMOUS, type TabAvatarMode } from "../types";

/**
 * Which account a tab reads and sends as, picked from every account signed in.
 *
 * Opened by right-clicking the tab or the composer -- the two places that
 * *are* the tab, one naming it and one speaking as it. Anonymous is always on
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
  onClose,
}: {
  tabId: string;
  x: number;
  y: number;
  onOptions?: () => void;
  onRename?: () => void;
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
  if (!tab) return null;

  const choose = (account: string): ContextMenuOption => {
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
  const background = (mode: TabAvatarMode, label: string): ContextMenuOption => ({
    label: tab.avatarMode === mode ? `${label} \u2713` : label,
    onSelect: () => void setTabAvatarMode(tabId, mode),
  });

  const tabActions: ContextMenuOption[] = [
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
            label: tab.mention.notify ? "Notify for matches ✓" : "Notify for matches",
            onSelect: () => void setMentionsTabNotify(tabId, !tab.mention!.notify),
          } satisfies ContextMenuOption,
          { separator: true } satisfies ContextMenuOption,
        ]
      : []),
    ...tabActions,
  ] : [
    ...accounts.map((account) => choose(account.id)),
    choose(ANONYMOUS),
    { separator: true },
    // What this one tab draws behind its name. The setting only stamps a new
    // tab, so this is the only thing that ever changes an open one -- and
    // there's no "follow the setting" to come back to, because a tab was never
    // following it.
    { heading: "Background avatar" },
    ...TAB_AVATAR_MODES.map((mode) => background(mode.id, mode.label)),
    { separator: true },
    ...tabActions,
  ];

  return <ContextMenu x={x} y={y} options={options} onClose={onClose} />;
}
