import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { handleIncomingMessage } from "../../../src/features/echo/EchoBot.ts";
import { createMockMessage } from "../../TestMessage.ts";

describe("handleIncomingMessage", () => {
  it("replies with 喵喵喵 when raw_message is strictly 喵喵喵 in a group", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "喵喵喵",
      message_type: "group",
      group_id: 20002,
    });

    await Effect.runPromise(handleIncomingMessage(item));
    expect(lastReply()).toBe("喵喵喵");
  });

  it("replies with 喵喵喵 when raw_message is strictly 喵喵喵 in private chat", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "喵喵喵",
      message_type: "private",
    });

    await Effect.runPromise(handleIncomingMessage(item));
    expect(lastReply()).toBe("喵喵喵");
  });

  it("does not reply when message contains whitespace", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: " 喵喵喵 ",
      message_type: "group",
    });

    await Effect.runPromise(handleIncomingMessage(item));
    expect(getReplies().length).toBe(0);
  });

  it("does not reply when message is different text or prefix", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "喵喵",
      message_type: "private",
    });

    await Effect.runPromise(handleIncomingMessage(item));
    expect(getReplies().length).toBe(0);
  });

  it("ignores self messages", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "喵喵喵",
      user_id: 99999,
      self_id: 99999,
    });

    await Effect.runPromise(handleIncomingMessage(item));
    expect(getReplies().length).toBe(0);
  });
});
