import { describe, expect, it } from "vitest";
import { mockAuthStatus } from "../dev/mockData";
import { hasPermissionChanges, permissionSelection, permissionSelectionKey } from "./permissions";

describe("account permission selections", () => {
  const auth = mockAuthStatus();
  const [moderator, basic] = auth.accounts;
  const catalog = auth.permissionCatalog;

  it("requires reauthorization for additions and removals, but not reverted edits", () => {
    const original = permissionSelection(catalog, moderator, {});
    expect(hasPermissionChanges(catalog, moderator, original)).toBe(false);
    expect(hasPermissionChanges(catalog, moderator, [...original, "channel"])).toBe(true);
    expect(hasPermissionChanges(catalog, moderator, original.filter((id) => id !== "moderation"))).toBe(true);
    expect(hasPermissionChanges(catalog, moderator, original)).toBe(false);
    expect(hasPermissionChanges(catalog, null, ["chat", "account"])).toBe(false);
    const reduced = { ...moderator, scopes: catalog.slice(0, 2).flatMap((group) => group.scopes) };
    expect(hasPermissionChanges(catalog, reduced, ["chat", "account"])).toBe(false);
  });

  it("follows the selected account instead of the shared request list", () => {
    expect(permissionSelection(catalog, moderator, {})).toEqual(["chat", "account", "moderation"]);
    expect(permissionSelection(catalog, basic, {})).toEqual(["chat"]);
    expect(permissionSelection(catalog, moderator, {})).toEqual(["chat", "account", "moderation"]);
  });

  it("keeps edits with their account and resets when replacement scopes arrive", () => {
    const drafts = { [permissionSelectionKey(basic)]: ["chat", "moderation"] };
    expect(permissionSelection(catalog, basic, drafts)).toEqual(["chat", "moderation"]);
    expect(permissionSelection(catalog, moderator, drafts)).toEqual(["chat", "account", "moderation"]);
    const replaced = { ...basic, scopes: catalog.flatMap((group) => group.scopes) };
    expect(permissionSelection(catalog, replaced, drafts)).toEqual(catalog.map((group) => group.id));
  });

  it("defaults all four new-account groups on and keeps that draft separate", () => {
    expect(permissionSelection(catalog, null, {})).toHaveLength(4);
    const drafts = { [permissionSelectionKey(null)]: ["chat", "account"] };
    expect(permissionSelection(catalog, null, drafts)).toEqual(["chat", "account"]);
    expect(permissionSelection(catalog, moderator, drafts)).toContain("moderation");
  });

  it("does not mark a partially granted group as checked", () => {
    const partial = { ...basic, scopes: [...basic.scopes, catalog[2].scopes[0]] };
    expect(permissionSelection(catalog, partial, {})).toEqual(["chat"]);
  });
});
