import type { AccountInfo, PermissionGroup } from "../types";

export function hasPermissionChanges(
  catalog: PermissionGroup[],
  account: AccountInfo | null,
  groups: string[],
): boolean {
  return account !== null && catalog.some((group) =>
    !group.required &&
    groups.includes(group.id) !== group.scopes.every((scope) => account.scopes.includes(scope)),
  );
}

// A replacement token starts a fresh draft based on its actual permissions.
export function permissionSelectionKey(account: AccountInfo | null): string {
  return account ? JSON.stringify([account.id, [...account.scopes].sort()]) : "new";
}

export function permissionSelection(
  catalog: PermissionGroup[],
  account: AccountInfo | null,
  drafts: Record<string, string[]>,
): string[] {
  return drafts[permissionSelectionKey(account)] ?? catalog
    .filter((group) => account === null || group.scopes.every((scope) => account.scopes.includes(scope)))
    .map((group) => group.id);
}
