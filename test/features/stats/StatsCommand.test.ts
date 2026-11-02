import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotGroupMessageEvent } from "@snowluma/sdk/types";
import { Effect, Layer } from "effect";
import { handleStatsCommand, resetCooldownForTest } from "../../../src/features/stats/StatsCommand.ts";
import { StatsRenderer } from "../../../src/features/stats/StatsRenderer.ts";
import { StatsRepository } from "../../../src/features/stats/StatsRepository.ts";
import type { IncomingMessage } from "../../../src/SnowLuma.ts";

describe("StatsCommand", () => {
  it("ignores non-command messages", async () => {
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 100,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "hello there" } }],
        raw_message: "hello there",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: () => {
          quoted = true;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.succeed(Buffer.from("fake-png")),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(quoted).toBe(false);
  });

  it("handles /stat command and sends image quote", async () => {
    resetCooldownForTest();
    let quotedPayload: unknown = null;
    let queryStartDate: string | undefined = undefined;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 101,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/stat" } }],
        raw_message: "/stat",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: (payload: unknown) => {
          quotedPayload = payload;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: (_groupId, startDate) => {
        queryStartDate = startDate;
        return Effect.succeed({
          groupTotal: 100,
          rows: [
            {
              userId: 20001,
              nickname: "Alice",
              totalCount: 100,
              mediaCount: 10,
              linkCount: 5,
              interactionCount: 2,
            },
          ],
        });
      },
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.succeed(Buffer.from("png-bytes")),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(queryStartDate).toBeDefined(); // Last 30 days query has startDate
    expect(quotedPayload).toBeDefined();
    expect(JSON.stringify(quotedPayload)).toContain("base64://");
  });

  it("handles /stat all command without startDate", async () => {
    resetCooldownForTest();
    let queryStartDate: string | undefined = "init";

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 102,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/stat all" } }],
        raw_message: "/stat all",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: () => Promise.resolve({} as never),
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: (_groupId, startDate) => {
        queryStartDate = startDate;
        return Effect.succeed({
          groupTotal: 100,
          rows: [{ userId: 20001, nickname: "Alice", totalCount: 100, mediaCount: 0, linkCount: 0, interactionCount: 0 }],
        });
      },
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.succeed(Buffer.from("png-bytes")),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(queryStartDate).toBeUndefined(); // All-time query has no startDate
  });

  it("replies with fallback text when group has no stats (Review Focus 4)", async () => {
    resetCooldownForTest();
    let quotedText: unknown = null;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 103,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/stat" } }],
        raw_message: "/stat",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: (payload: unknown) => {
          quotedText = payload;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(quotedText).toBe("本群暂无统计数据。");
  });
  it("replies with fallback text when group has interaction rows but 0 messages", async () => {
    resetCooldownForTest();
    let quotedText: unknown = null;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 107,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/stat" } }],
        raw_message: "/stat",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: (payload: unknown) => {
          quotedText = payload;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () =>
        Effect.succeed({
          groupTotal: 0,
          rows: [
            {
              userId: 20001,
              nickname: "Alice",
              totalCount: 0,
              mediaCount: 0,
              linkCount: 0,
              interactionCount: 5,
            },
          ],
        }),
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(quotedText).toBe("本群暂无统计数据。");
  });


  it("throttles rapid repeated /stat queries in same group (Review Focus 5)", async () => {
    resetCooldownForTest();
    let callCount = 0;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 104,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/stat" } }],
        raw_message: "/stat",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: () => {
          callCount += 1;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () =>
        Effect.succeed({
          groupTotal: 10,
          rows: [{ userId: 20001, nickname: "Alice", totalCount: 10, mediaCount: 0, linkCount: 0, interactionCount: 0 }],
        }),
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.succeed(Buffer.from("png")),
    });

    const layer = Layer.merge(
      Layer.succeed(StatsRepository, mockRepo),
      Layer.succeed(StatsRenderer, mockRenderer),
    );

    // Call 1: passes
    await Effect.runPromise(handleStatsCommand(item).pipe(Effect.provide(layer)));
    expect(callCount).toBe(1);

    // Call 2 immediately: throttled
    await Effect.runPromise(handleStatsCommand(item).pipe(Effect.provide(layer)));
    expect(callCount).toBe(1);
  });

  it("handles /me command and quotes formatted personal stats", async () => {
    let quotedText: unknown = null;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 105,
        group_id: 10001,
        user_id: 20001,
        message: [{ type: "text", data: { text: "/me" } }],
        raw_message: "/me",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: (payload: unknown) => {
          quotedText = payload;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.die("not called"),
      getUserStats: (_groupId, userId) =>
        Effect.succeed({
          userId,
          nickname: "Alice",
          stats30d: { totalCount: 200, mediaCount: 50, linkCount: 20, interactionCount: 10, rank: 2 },
          statsAll: { totalCount: 800, mediaCount: 200, linkCount: 80, interactionCount: 40, rank: 1 },
        }),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("not called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    expect(typeof quotedText).toBe("string");
    const text = quotedText as string;
    expect(text).toContain("个人群聊统计 (近 30 天 / 历史累计)");
    expect(text).toContain("消息总计：200 / 800 条 (排名第 2 / 1)");
    expect(text).toContain("媒体消息：50 / 200 条");
    expect(text).toContain("包含链接：20 / 80 条");
    expect(text).toContain("互动次数：10 / 40 次");
  });

  it("handles /me for user with 0 messages (Review Focus 3)", async () => {
    let quotedText: unknown = null;

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 106,
        group_id: 10001,
        user_id: 99999,
        message: [{ type: "text", data: { text: "/me" } }],
        raw_message: "/me",
        font: 0,
        sender: { user_id: 99999, nickname: "Newbie" },
      } as OneBotGroupMessageEvent,
      context: {
        quote: (payload: unknown) => {
          quotedText = payload;
          return Promise.resolve({} as never);
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.die("not called"),
      getUserStats: (_groupId, userId) =>
        Effect.succeed({
          userId,
          nickname: "Newbie",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("not called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
          ),
        ),
      ),
    );

    const text = quotedText as string;
    expect(text).toContain("排名第 - / -");
    expect(text).toContain("消息总计：0 / 0 条");
  });
});
