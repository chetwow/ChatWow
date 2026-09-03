#!/usr/bin/env python3
"""Set the version in the five files that have to agree.

    python3 scripts/bump-version.py 0.6.0

`package.json`, `package-lock.json` (in two places), `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.lock`.

This used to be a cosmetic bug and isn't any more. The release workflow takes
the tag from `tauri.conf.json` (`tagName: v__VERSION__`) while the version
compiled into the binary is Cargo's, and the updater compares *that* against
what's on the release. If the two disagree, an installed copy will either offer
an update to a version it already is or refuse the one it isn't.

Refuses to run on a dirty tree: this rewrites five files at once, and `git
checkout` is the only sane undo.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Anything the tag `v<version>` would accept, which is what has to end up in
# `latest.json` for a comparison against it to mean anything.
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def set_json(path: Path, version: str, keys: list[list[str]]) -> None:
    """Rewrite one or more dotted paths, leaving the rest of the file alone."""
    text = path.read_text()
    data = json.loads(text)
    for key in keys:
        node = data
        for part in key[:-1]:
            if part not in node:
                fail(f"{path}: no {'.'.join(key)}")
            node = node[part]
        node[key[-1]] = version
    # Both files are npm's or Tauri's own formatting: two spaces, trailing
    # newline. Round-tripping through json keeps that.
    path.write_text(json.dumps(data, indent=2) + "\n")


def set_cargo_toml(path: Path, version: str) -> None:
    """Only the `[package]` version -- every dependency has one too."""
    text = path.read_text()
    package = re.search(r"^\[package\]$.*?(?=^\[)", text, re.M | re.S)
    if not package:
        fail(f"{path}: no [package] section")
    block = package.group(0)
    bumped, count = re.subn(r'^version = ".*?"$', f'version = "{version}"', block, count=1, flags=re.M)
    if count != 1:
        fail(f"{path}: no version in [package]")
    path.write_text(text[: package.start()] + bumped + text[package.end() :])


def set_cargo_lock(path: Path, version: str) -> None:
    """The one `[[package]]` block that is this crate."""
    text = path.read_text()
    pattern = re.compile(r'(\[\[package\]\]\nname = "chatwow"\nversion = )".*?"')
    bumped, count = pattern.subn(rf'\1"{version}"', text, count=1)
    if count != 1:
        fail(f"{path}: no chatwow package entry")
    path.write_text(bumped)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: bump-version.py <version>, e.g. 0.6.0")
    version = sys.argv[1].lstrip("v")
    if not VERSION_RE.match(version):
        fail(f'"{version}" is not a version -- expected something like 0.6.0 or 0.6.0-rc.1')

    dirty = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    if dirty:
        fail("the tree has uncommitted changes -- commit or stash them first")

    set_json(ROOT / "package.json", version, [["version"]])
    set_json(ROOT / "package-lock.json", version, [["version"], ["packages", "", "version"]])
    set_cargo_toml(ROOT / "src-tauri" / "Cargo.toml", version)
    set_json(ROOT / "src-tauri" / "tauri.conf.json", version, [["version"]])
    set_cargo_lock(ROOT / "src-tauri" / "Cargo.lock", version)

    print(f"set five files to {version}")
    print("review, commit, then:")
    print(f"  git tag v{version} && git push origin v{version}")


if __name__ == "__main__":
    main()
