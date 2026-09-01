import { invoke } from "@tauri-apps/api/core";
import type { AuthStatus, ChannelHit, DeviceCode, EmoteIndex, Preferences } from "../types";

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
  logout: () => invoke<AuthStatus>("logout"),
  listChannels: () => invoke<string[]>("list_channels"),
  joinChannel: (channel: string) => invoke<string[]>("join_channel", { channel }),
  partChannel: (channel: string) => invoke<string[]>("part_channel", { channel }),
  reorderChannels: (channels: string[]) => invoke<string[]>("reorder_channels", { channels }),
  sendMessage: (channel: string, text: string, replyToId?: string) =>
    invoke<void>("send_message", { channel, text, replyToId }),
  /** Runs a slash command; resolves with the line to print into the channel. */
  runChatCommand: (channel: string, input: string) =>
    invoke<string>("run_chat_command", { channel, input }),
  emoteIndex: (channel: string) => invoke<EmoteIndex>("emote_index", { channel }),
  /** Empty when signed out -- Helix has no unauthenticated channel search. */
  searchChannels: (query: string) => invoke<ChannelHit[]>("search_channels", { query }),
  recordEmoteUses: (channel: string, names: string[]) =>
    invoke<void>("record_emote_uses", { channel, names }),
  preferences: () => invoke<Preferences>("preferences"),
  setPreferences: (preferences: Preferences) =>
    invoke<Preferences>("set_preferences", { preferences }),
};
