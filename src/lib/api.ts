import { invoke } from "@tauri-apps/api/core";
import type {
  AuthStatus,
  ChannelHit,
  DeviceCode,
  EmoteIndex,
  LinkPreview,
  PreviewImage,
  MentionFilter,
  Preferences,
  Tab,
  TabAvatarMode,
  UpdateState,
  UserCard,
} from "../types";

export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  /** Empty string clears the override and goes back to the compiled-in ID. */
  setClientIdOverride: (clientId: string) =>
    invoke<AuthStatus>("set_client_id_override", { clientId }),
  startDeviceAuth: () => invoke<DeviceCode>("start_device_auth"),
  pollDeviceAuth: (deviceCode: string) =>
    invoke<{ status: "pending" | "granted" | "failed"; detail?: string; login?: string }>(
      "poll_device_auth",
      { deviceCode },
    ),
  /** Which optional permission groups the next sign-in asks Twitch for. */
  setPermissionGroups: (groups: string[]) =>
    invoke<AuthStatus>("set_permission_groups", { groups }),
  /** Signs one account out. Its tabs stay open and fall back to anonymous. */
  removeAccount: (id: string) => invoke<AuthStatus>("remove_account", { id }),
  /** Which account a newly opened tab reads as. */
  setDefaultAccount: (id: string) => invoke<AuthStatus>("set_default_account", { id }),
  listTabs: () => invoke<Tab[]>("list_tabs"),
  /** The id is ours to mint, so a new view has a key before the round trip. */
  addTab: (tab: Tab, reopening = false) => invoke<Tab[]>("add_tab", { ...tab, reopening }),
  closeTab: (id: string) => invoke<Tab[]>("close_tab", { id }),
  /** Change a custom mentions listener's visible name. */
  renameMentionsTab: (id: string, name: string) =>
    invoke<Tab[]>("rename_mentions_tab", { id, name }),
  /** Enable or disable sound and rose-badge notifications for one listener. */
  setMentionsTabNotify: (id: string, notify: boolean) =>
    invoke<Tab[]>("set_mentions_tab_notify", { id, notify }),
  /** Replace every editable setting on one custom mentions listener. */
  updateMentionsTab: (id: string, mention: MentionFilter) =>
    invoke<Tab[]>("update_mentions_tab", { id, mention }),
  /** Read (and send) as a different account, keeping the tab and its messages. */
  setTabAccount: (id: string, account: string) =>
    invoke<Tab[]>("set_tab_account", { id, account }),
  /** Which picture one tab draws behind its name. */
  setTabAvatarMode: (id: string, mode: TabAvatarMode) =>
    invoke<Tab[]>("set_tab_avatar_mode", { id, mode }),
  reorderTabs: (ids: string[]) => invoke<Tab[]>("reorder_tabs", { ids }),
  /** Owner avatars fetched so far, by channel. Empty when signed out. */
  channelAvatars: () => invoke<Record<string, string>>("channel_avatars"),
  /** Which joined channels are live right now. Empty when signed out. */
  liveChannels: () => invoke<string[]>("live_channels"),
  sendMessage: (account: string, channel: string, text: string, replyToId?: string) =>
    invoke<void>("send_message", { account, channel, text, replyToId }),
  /** Runs a slash command; resolves with the line to print into the channel. */
  runChatCommand: (account: string, channel: string, input: string) =>
    invoke<string>("run_chat_command", { account, channel, input }),
  emoteIndex: (account: string, channel: string) =>
    invoke<EmoteIndex>("emote_index", { account, channel }),
  /** Empty when signed out -- Helix has no unauthenticated channel search. */
  searchChannels: (query: string) => invoke<ChannelHit[]>("search_channels", { query }),
  /** Everything the card behind a clicked username shows. Works signed out. */
  userCard: (login: string, channel: string) => invoke<UserCard>("user_card", { login, channel }),
  /** What the page behind a link says about itself, or null when it says nothing. */
  linkPreview: (url: string) => invoke<LinkPreview | null>("link_preview", { url }),
  linkPreviewImage: (url: string) =>
    invoke<PreviewImage | null>("link_preview_image", { url }),
  recordEmoteUses: (account: string, channel: string, names: string[]) =>
    invoke<void>("record_emote_uses", { account, channel, names }),
  preferences: () => invoke<Preferences>("preferences"),
  setPreferences: (preferences: Preferences) =>
    invoke<Preferences>("set_preferences", { preferences }),
  lastSeenVersion: () => invoke<string>("last_seen_version"),
  acknowledgeWhatsNew: () => invoke<void>("acknowledge_whats_new"),
  /** Reveals the log folder, and resolves with where it is. */
  openLogDir: () => invoke<string>("open_log_dir"),

  updateState: () => invoke<UpdateState>("update_state"),
  checkForUpdates: () => invoke<UpdateState>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),
  restartApp: () => invoke<void>("restart_app"),
};
