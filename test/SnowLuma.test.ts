import { describe, expect, it } from "bun:test";
import { type SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotNoticeEvent } from "@snowluma/sdk/types";
import { Effect, Queue, Stream } from "effect";
import { type IncomingNotice, SnowLumaClient } from "../src/SnowLuma.ts";

describe("SnowLumaClient notice stream extension", () => {
  it("provides notices stream on SnowLumaClient service", async () => {
    const noticeQueue = await Effect.runPromise(
      Queue.unbounded<IncomingNotice>(),
    );

    const mockNoticeEvent: OneBotNoticeEvent = {
      time: 1700000000,
      self_id: 123456,
      post_type: "notice",
      notice_type: "notify",
    };

    const mockContext = {
      quote: () => Promise.resolve({} as never),
    } as unknown as SnowLumaEventContextWithQuote<OneBotNoticeEvent>;

    Queue.offerUnsafe(noticeQueue, {
      event: mockNoticeEvent,
      context: mockContext,
    });

    const clientInstance = SnowLumaClient.of({
      client: {} as never,
      messages: Stream.empty,
      notices: Stream.fromQueue(noticeQueue),
    });

    const program = Effect.gen(function* () {
      const { notices } = clientInstance;
      const first = yield* Stream.runHead(notices);
      expect(first._tag).toBe("Some");
      if (first._tag === "Some") {
        expect(first.value.event.notice_type).toBe("notify");
      }
    });

    await Effect.runPromise(program);
  });
});
