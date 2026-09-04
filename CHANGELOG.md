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
- Added named mentions tabs that can listen for multiple signed-in accounts and phrases across
  selected open channels, with optional sound and mention badges, a rename action, and a full
  options editor for changing the listener after creation.
- Added followed users to listener tabs, including chatter-name context-menu and user-card actions
  that create a listener for that user in the current channel.
- Added a configurable warning before closing the last channel tab feeding a mentions listener.
- Added username suggestion popups when typing `@` in chat and when entering users in listener
  settings, populated from chatters seen during the current session.
- Added moderator context-menu controls for deleting messages, banning or unbanning users, and
  applying default or custom-length timeouts, with a configurable default timeout duration.

### Changed

- Moved the new-tab panel higher, increased its available height for listener configuration, and
  kept channel search results directly below the join-channel input.
- Reordered and clarified listener filter labels, and removed redundant helper and keyboard-
  instruction text.

### Removed

- Removed the 7TV emote-change announcement toggle; set changes are now always announced.

### Fixed

- Fixed the account permission reminder so required scopes cannot hold it open and it disappears
  once every affected account has the newly enabled permissions.
- Disabled spelling and correction suggestions in tab search and kept its status area from
  changing the search bar's height.
- Cleared message highlighting and returned chat to the present when tab search closes, and made
  its title-bar icon toggle the search bar.
- Excluded messages sent by signed-in accounts from a listener's phrase matches.
- Prevented the full listener form and edited filters from retroactively collecting messages, and
  made listeners created from a chatter's context menu start with notifications disabled while
  retaining their one-time backfill of that user's current-channel messages.
- Kept context menus open when incoming messages or manual scrolling move the chat beneath them.
- Kept live messages arriving during recent-history loading in order and removed overlapping
  history copies of those messages.
- Made the arrow keys move keyboard focus through channel search results instead of scrolling the
  result list.
