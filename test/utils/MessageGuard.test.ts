import { describe, expect, it } from "bun:test";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { isSelfMessage } from "../../src/utils/MessageGuard.ts";

const event = (fields: Record<string, unknown>): OneBotMessageEvent =>
  fields as unknown as OneBotMessageEvent;

describe("isSelfMessage", () => {
  it("treats message_sent echoes as self-sent", () => {
    expect(
      isSelfMessage(event({ post_type: "message_sent", user_id: 10001 })),
    ).toBe(true);
  });

  it("treats events whose user_id equals self_id as self-sent", () => {
    expect(
      isSelfMessage(event({ user_id: 2840296514, self_id: 2840296514 })),
    ).toBe(true);
  });

  it("accepts group messages from other users", () => {
    expect(
      isSelfMessage(
        event({
          post_type: "message",
          message_type: "group",
          user_id: 10001,
          self_id: 2840296514,
        }),
      ),
    ).toBe(false);
  });

  it("does not flag events missing user_id or self_id", () => {
    expect(isSelfMessage(event({ raw_message: "喵喵喵" }))).toBe(false);
    expect(isSelfMessage(event({ user_id: 10001 }))).toBe(false);
  });
});
