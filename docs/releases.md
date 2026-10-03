# Releases and updates

[Architecture map](../ARCHITECTURE.md)

Sources: [release workflow](../.github/workflows/release.yml),
[version script](../scripts/bump-version.py), [updater.rs](../src-tauri/src/updater.rs),
[Tauri config](../src-tauri/tauri.conf.json), [releaseNotes.ts](../src/lib/releaseNotes.ts).

## Preparing a release

1. From a clean checkout, run `python3 scripts/bump-version.py --no-commit <version>`. It updates
   the five version-bearing files: package manifest, npm lockfile, Cargo manifest/lockfile, and
   Tauri config. Without `--no-commit`, it commits those changes automatically.
2. Move the applicable Unreleased notes into a dated section with that exact version in
   [CHANGELOG.md](../CHANGELOG.md). The bundled What's New dialog and its regression test require
   that section; only the running version's notes appear. Dismissal persists `last_seen_version`.
3. Complete [verification](development.md#checks), commit the version and release notes, and push
   the intended commit to main before dispatching `gh workflow run release.yml --ref main`.
   Running from main shares the default-branch npm/Rust caches. A pushed `v<version>` tag is the
   fallback trigger.
4. Inspect the completed draft release and all platform assets. The workflow validates manifest/
   lockfile agreement and a triggering tag's version, and classifies prereleases from the package
   version rather than the triggering branch name.
5. Verify the release's actual `draft` and `prerelease` flags before publishing. Publication makes
   a stable release available to installed apps through the latest-release endpoint; workflow
   configuration alone does not establish the release's current state.

The version gate uses locked Cargo metadata before tests/builds can silently repair an inconsistent
release lockfile. Verification then runs frontend tests/build, Rust formatting/strict Clippy/tests,
and npm/RustSec audits. Installs skip automatic npm audits because one explicit audit is
authoritative and retries only transient advisory-service failures.

## Packaging and trust

The matrix builds macOS ARM/Intel, Windows, and Linux installers. Keep `max-parallel: 1`:
`tauri-action` downloads/merges/reuploads shared `latest.json`, so concurrent platform jobs can
silently overwrite another platform's entry. Keep the `app` and `appimage` bundle targets even
when shipping DMG/DEB/RPM installers; updater artifacts depend on them. Windows ships NSIS rather
than MSI, with `/P /UPDATE /R` updater arguments to avoid normal reinstall/running-app prompts.

`TAURI_SIGNING_PRIVATE_KEY` and its optional password sign updater artifacts; the matching public
key is compiled into every installed app. Preserve the private key: existing installations cannot
accept artifacts signed by an unrelated replacement. Updater signatures remain required even
when the operating system trusts the publisher.

macOS also requires Developer ID signing, hardened runtime, timestamping, and notarization. The
workflow imports the certificate into an isolated temporary keychain, keeps the App Store Connect
key under runner temporary storage, and cleans both in an always-run step. A post-build gate runs
`codesign`, `stapler`, and `spctl`. Their success establishes Apple trust separately from updater
provenance. The workflow itself documents required secret names; do not duplicate secret values
in documentation or logs.

`npm run build:local` disables updater artifact creation for local packaging. A fork can set
`TWITCH_CLIENT_ID` at build time; no Twitch client secret is needed.

## Runtime updater

Rust owns check/download/install and exposes state plus explicit commands. Do not grant the
webview `updater:default`; it only needs display state and button actions. Each transition both
stores and emits the same snapshot, and settings re-reads it on mount. A shared async operation
lock prevents launch checks, manual checks, and installs from overwriting one another's state.

`latest.json` is unsigned release metadata containing artifact signatures. The updater uses its
compiled public key to verify the downloaded artifact before replacement. Windows installation
exits the process and NSIS relaunches; it never reports the `ready` stage. macOS/Linux publish
`ready` only after signature verification and installation both succeed, then wait for restart.
Later checks preserve that stage so the still-running old version cannot hide the restart action.
The title-bar update indicator occupies a fixed slot so state changes do not alter layout.

`CHATWOW_UPDATE_ENDPOINT` can point a hand-installed test build at a prerelease's own manifest
to rehearse updates. Signature checking still applies. Stable latest-release URLs exclude drafts
and prereleases. There is no staged rollout or downgrade path: repairing a shipped release
requires a higher version containing the fix.
