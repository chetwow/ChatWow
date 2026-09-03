# Changelog

All notable changes to ChatWow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added selectable account cards for editing existing permissions or choosing them before signing
  in a new account.
- Added search for the active chat tab, with a title-bar control, match navigation, and
  `Ctrl/Cmd+F` shortcut.

### Fixed

- Fixed the account permission reminder so required scopes cannot hold it open and it disappears
  once every affected account has the newly enabled permissions.
- Disabled spelling and correction suggestions in tab search and kept its status area from
  changing the search bar's height.
- Cleared message highlighting and returned chat to the present when tab search closes, and made
  its title-bar icon toggle the search bar.
