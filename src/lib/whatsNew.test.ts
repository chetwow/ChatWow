import { describe, expect, it } from "vitest";
import changelog from "../../CHANGELOG.md?raw";
import packageInfo from "../../package.json";
import { parseReleaseNotes } from "./releaseNotes";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something later.

## [2.0.0] - 2026-09-04

### Added

- A new thing with
  a wrapped explanation.

### Fixed

- One fix.

## [1.0.0] - 2026-09-03

### Added

- An older thing.
`;

describe("release notes", () => {
  it("reads only the exact version and folds wrapped bullets", () => {
    expect(parseReleaseNotes(CHANGELOG, "2.0.0")).toEqual({
      version: "2.0.0",
      sections: [
        { title: "Added", items: ["A new thing with a wrapped explanation."] },
        { title: "Fixed", items: ["One fix."] },
      ],
    });
  });

  it("does not fall back to unreleased or an older version", () => {
    expect(parseReleaseNotes(CHANGELOG, "3.0.0")).toBeNull();
  });

  it("has a release section for the version being built", () => {
    expect(parseReleaseNotes(changelog, packageInfo.version)).not.toBeNull();
  });
});
