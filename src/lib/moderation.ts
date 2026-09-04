import type { StoredMessage } from "../types";

/** Whether one Twitch clear event applies to this stored message. */
export function messageCleared(
  message: StoredMessage,
  messageId: string | null | undefined,
  login: string | null | undefined,
): boolean {
  if (messageId) return message.id === messageId;
  const normalizedLogin = login?.toLocaleLowerCase() ?? "";
  if (normalizedLogin) return message.login.toLocaleLowerCase() === normalizedLogin;
  // CLEARCHAT without either target is Twitch's channel-wide /clear event.
  return true;
}
