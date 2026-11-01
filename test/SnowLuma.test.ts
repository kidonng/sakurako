import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { Effect, Option, Queue, Stream } from "effect";
import { type IncomingMessage, SnowLumaClient } from "../src/SnowLuma.ts";

describe("SnowLumaClient", () => {
  it("exposes service identifier and layer", () => {
    expect(SnowLumaClient).toBeDefined();
    expect(SnowLumaClient.layer).toBeDefined();
  });

  it("emits incoming messages from queue to stream", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<IncomingMessage>());
    const stream = Stream.fromQueue(queue);

    const mockItem: IncomingMessage = {
      event: {
        raw_message: "喵喵喵",
        message_type: "group",
        user_id: 12345,
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async () => {},
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    await Effect.runPromise(Queue.offer(queue, mockItem));
    const item = await Effect.runPromise(Stream.runHead(stream));
    expect(Option.isSome(item)).toBe(true);
    if (Option.isSome(item)) {
      expect(item.value.event.raw_message).toBe("喵喵喵");
    }
  });
});
