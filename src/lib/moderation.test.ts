import { describe, expect, it } from "vitest";
import { messageCleared } from "./moderation";
import type { StoredMessage } from "../types";

const message = { id: "message-1", login: "SomeUser" } as StoredMessage;

describe("messageCleared", () => {
  it("matches one message id", () => {
    expect(messageCleared(message, "message-1", undefined)).toBe(true);
    expect(messageCleared(message, "message-2", undefined)).toBe(false);
  });

  it("matches a user without case sensitivity", () => {
    expect(messageCleared(message, undefined, "someuser")).toBe(true);
    expect(messageCleared(message, undefined, "otheruser")).toBe(false);
  });

  it("matches every message for a channel-wide clear", () => {
    expect(messageCleared(message, undefined, undefined)).toBe(true);
  });
});
