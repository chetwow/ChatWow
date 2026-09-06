# Changelog

All notable changes to ChatWow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A floating close-player button appears at the top of chat when a retained video is off screen.

- Options to keep video players open off screen (on by default) and in inactive tabs (off by default).

- Optional inline Twitch clip playback, with a browser fallback and link-menu action.

- Optional inline YouTube playback from chat links, with a browser prompt when playback fails.
- Copy link addresses from any link context menu, and open inline YouTube links in a browser.

- Hover a live channel tab for 1.5 seconds to see its stream title and category.
- Added “Show live stream thumbnails on hover” in Tabs settings, off by default.

### Changed

- Opening an inline video closes the previous player and stops its playback across chat panes.

- Default all four permission options on when adding an account.

### Fixed

- Scale inline Twitch clips to fit narrow chat panes without horizontal scrolling.

- Account permission checkboxes now follow the selected account, keeping edits separate and
  avoiding incorrect re-login reminders when switching accounts. Both enabling and disabling
  permissions now explain that signing in again is required.

- Show readable days, hours, minutes, and seconds in timeout and chat-mode notices and
  command confirmations instead of large raw durations.

## [1.4.0] - 2026-09-06

### Added

- Replaced the title-bar app name with an info button showing ChatWow, its version, and a
  GitHub link without hover previews.
- Added a "Display message effect animations" option; turning it off keeps static clouds,
  glow, and party emotes. Power-up switches now read "Display message effects", "Display
  message effect animations", and "Display Gigantify", all on by default.
- Show Twitch pinned messages beneath the tabs, with an X to dismiss each pin and a
  "View pinned message" tab-menu option to bring it back. New pins appear automatically.

### Fixed

- Tab unread counts now include only chat messages and whispers, excluding connection status
  lines and Twitch event notifications.
- Restored signed-in chat after sleep when Twitch credentials expire, checking and renewing them
  before reconnecting and retrying promptly while the network returns.
- Recovered stalled chat connections with connection, login, write, and heartbeat timeouts.
- Retried rejected Twitch credentials automatically and kept renewed credentials if the network
  drops during the follow-up check.

## [1.3.0] - 2026-09-05

### Added

- Added per-user and per-channel notification muting, which silences sounds while preserving
  highlights, badges, and listener messages. Manage muted and ignored notifications in settings,
  message/chatter menus, and channel-tab menus.
- Added Cosmic Abyss, Rainbow Eclipse, and Emote Party animated message effects, with Power-ups
  settings and a message context-menu toggle. Background animations pause off screen and respect
  reduced-motion preferences while keeping messages readable and selectable.
- Added Twitch Gigantify emotes, with Power-ups settings to enable or disable enlargement and
  adjust its size from 100% to 500% (400% by default), plus a message context-menu toggle.
- Rendered Twitch Cheermotes as animated tier artwork with their Bits amounts, including
  channel-custom Cheermotes, image fallbacks, and simulated chat examples.
- Added Bits totals on cheers and notices for bans, timeouts, deleted messages, chat clears,
  and chat-mode changes. Added shared-chat session notifications and private AutoMod feedback
  for your messages, plus moderation activity, VIP/moderator changes, Hype Trains, and shoutouts
  when your account has the required Twitch role and permissions.

### Fixed

- Made chat notifications readable when Twitch omits their description, including announcements,
  watch streaks, moderator anniversaries, subscription events, raids, Bits badges, charity
  donations, and shared-chat notices. Unrecognized events now show a fallback instead of an empty row.
- Kept an open link preview anchored while incoming chat moves its source link, dismissing it on
  Escape or deliberate pointer movement away while allowing movement over the link or preview,
  crossing the gap between them, and a small movement margin instead of reacting to
  layout-generated hover changes or hand jitter.
- Reconnected Twitch chat and whisper sockets automatically after a laptop or desktop wakes from
  system sleep, including the ordinary missed-message recovery and live-channel refresh.

## [1.2.0] - 2026-09-05

### Added

- Added Chrome-style keyboard shortcuts for selecting tabs by number, jumping to the final tab,
  and cycling forward or backward with platform-native modifier combinations, plus `Cmd+,` for
  opening Settings on macOS.
- Added a session-level Reopen Closed Tab action to the tab bar and the Chrome-style
  `Ctrl/Cmd+Shift+T` shortcut, with safe Anonymous fallback when its account was removed.
- Added optional clickable markers on the chat scrollbar track showing where highlighted mentions
  occurred in the retained log, with a message preview on hover.
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
