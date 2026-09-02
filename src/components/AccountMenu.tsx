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
  onClose,
}: {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const accounts = useChat((state) => state.auth.accounts);
  const tab = useChat((state) => state.tabs.find((open) => open.id === tabId));
  const setTabAccount = useChat((state) => state.setTabAccount);
  const closeTab = useChat((state) => state.closeTab);
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

  const options: ContextMenuOption[] = [
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
    { label: "Close tab", onSelect: () => void closeTab(tabId) },
  ];

  return <ContextMenu x={x} y={y} options={options} closeOnScroll={false} onClose={onClose} />;
}
