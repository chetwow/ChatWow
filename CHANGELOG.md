# Changelog

All notable changes to ChatWow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added six built-in color themes, with the original color scheme named Twitch.

### Changed

- Clarified the active-tab notification control as a sound mute and added an independent option
  to mute all notification sounds while the ChatWow window is active.
- Persisted Twitch and 7TV badge metadata and images in the bounded cache, including expiring
  positive and no-badge 7TV answers, so familiar badges render without a cold-start refetch.
- Reorganized Appearance settings and expanded the composer avatar control with Twitch avatar,
  theme-colored generic initials, and hidden options.
- Signed and notarized macOS releases with Apple Developer ID and enabled automatic in-app update
  installation on macOS.

## [1.1.0] - 2026-09-04

### Added

- Added Twitch GIF message rendering, with a display toggle, an underlined hover fallback, and
  adjustable sizing.
- Added an offline What's New popup on the first launch of each version, populated from that
  version's changelog entry.

### Changed

- Expanded the emote image cache into a 300 MB recency cache that keeps recently visited
  channels warm, prioritizes emotes reachable from open channels, and coalesces simultaneous
  requests for the same uncached image.
- Cached 7TV, BetterTTV, and FrankerFaceZ catalogs across launches and channel revisits while
  continuing to refresh them in the background, so emotes resolve sooner without preserving
  stale provider data as authoritative.

### Fixed

- Prevented simultaneous account joins from fetching the same room assets more than once, and
  prevented a slower catalog refresh from overwriting a newer live 7TV set update.

## [1.0.0] - 2026-09-03

### Added

- Added an account-card interface for selecting existing accounts, reviewing their granted
  permissions, and choosing permissions before signing in with a new account.
- Added search for the active chat tab, with a title-bar control, match navigation, and
  `Ctrl/Cmd+F` shortcut.
- Added named listener tabs that collect messages from selected open channels when they mention
  selected signed-in accounts, contain configured phrases, or are sent by configured users.
  Listener tabs support optional sound and tab-bar notifications, renaming, and editing all
  filters after creation.
- Added chatter context-menu and user-card actions for quickly opening a listener tab for that
  user's messages in the current channel.
- Added an optional warning before closing the last channel tab feeding a listener.
- Added username suggestion popups when typing `@` in chat and when entering users in listener
  settings, populated from chatters seen during the current session.
- Added moderator context-menu controls for deleting messages, banning or unbanning users, and
  applying default or custom-length timeouts, with a configurable default timeout duration.

### Changed

- Expanded and repositioned the new-tab panel for listener configuration, with channel search
  results kept directly below the join-channel input.
- Clarified and reorganized listener settings.
- 7TV emote-set changes are now always announced.

### Removed

- Removed the 7TV emote-change announcement setting.

### Fixed

- Fixed the account permission reminder so required scopes cannot hold it open and it disappears
  once every affected account has the newly enabled permissions.
- Kept context menus open when incoming messages or manual scrolling move the chat beneath them.
- Kept live messages arriving during recent-history loading in order and removed overlapping
  history copies of those messages.
- Fixed connection and history-loader races that could duplicate history or leave a quickly
  reopened channel waiting on stale work.
- Applied channel-wide `/clear` moderation events to every visible message in the affected chat.
- Prevented device authorization polls from overlapping or leaving the sign-in screen stuck after
  an error.
- Serialized update checks and installation so concurrent requests cannot replace the pending
  update or show contradictory progress.
- Made settings saves atomic and preserve malformed files for recovery instead of overwriting
  them with defaults.
- Made the arrow keys move keyboard focus through channel search results instead of scrolling the
  result list.

### Security

- Routed direct images and page thumbnails through bounded backend fetches that reject and avoid
  private-network addresses at every DNS resolution and redirect hop.
- Restricted the settings directory and credentials file to the current user on Unix systems.
