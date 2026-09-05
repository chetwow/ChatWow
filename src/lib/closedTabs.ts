import { ANONYMOUS, type AuthStatus, type PaneIndex, type Tab } from "../types";

export type ClosedTab = {
  tab: Tab;
  pane: PaneIndex;
  index: number;
};

/**
 * Bring a closed tab's account references in line with the accounts that
 * still exist. A channel can always read anonymously; a custom listener with
 * no remaining account, user, or phrase has no possible match and is not
 * restorable.
 */
export function restorableClosedTab(closed: ClosedTab, auth: AuthStatus): ClosedTab | null {
  const held = new Set(auth.accounts.map((account) => account.id));
  const tab = closed.tab;

  if (!tab.mention) {
    return {
      ...closed,
      tab: {
        ...tab,
        account: tab.account && !held.has(tab.account) ? ANONYMOUS : tab.account,
      },
    };
  }

  const accounts = tab.mention.accounts.filter((account) => held.has(account));
  if (accounts.length === 0 && tab.mention.users.length === 0 && tab.mention.phrases.length === 0) {
    return null;
  }
  return {
    ...closed,
    tab: {
      ...tab,
      account: accounts[0] ?? ANONYMOUS,
      mention: { ...tab.mention, accounts },
    },
  };
}
