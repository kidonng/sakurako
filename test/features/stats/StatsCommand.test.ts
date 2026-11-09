import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { handleStatsCommand } from "../../../src/features/stats/StatsCommand.ts";
import { StatsCooldown } from "../../../src/features/stats/StatsCooldown.ts";
import { StatsRenderer } from "../../../src/features/stats/StatsRenderer.tsx";
import { StatsRepository } from "../../../src/features/stats/StatsRepository.ts";
import { createMockMessage } from "../../TestMessage.ts";

describe("StatsCommand", () => {
  it("ignores non-command messages", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "hello there",
      message: [{ type: "text", data: { text: "hello there" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(getReplies().length).toBe(0);
  });

  it("ignores non-group messages", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "/stat",
      message: [{ type: "text", data: { text: "/stat" } }],
      message_type: "private",
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.die("not called"),
      getUserStats: () => Effect.die("not called"),
    });
    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("not called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(getReplies().length).toBe(0);
  });

  it("handles /stat command and sends image directly", async () => {
    let queryStartDate: string | undefined = undefined;

    const { item, lastReply } = createMockMessage({
      raw_message: "/stat",
      message: [{ type: "text", data: { text: "/stat" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(queryStartDate).toBeDefined(); // Last 30 days query has startDate
    const replied = lastReply();
    expect(replied).toBeDefined();
    expect(JSON.stringify(replied)).toContain("base64://");
  });

  it("handles /stat all command without startDate", async () => {
    let queryStartDate: string | undefined = "init";

    const { item } = createMockMessage({
      raw_message: "/stat all",
      message: [{ type: "text", data: { text: "/stat all" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
              mediaCount: 0,
              linkCount: 0,
              interactionCount: 0,
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
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(queryStartDate).toBeUndefined(); // All-time query has no startDate
  });

  it("replies with fallback text when group has no stats (Review Focus 4)", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "/stat",
      message: [{ type: "text", data: { text: "/stat" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(lastReply()).toBe("本群暂无统计数据。");
  });

  it("replies with fallback text when group has interaction rows but 0 messages", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "/stat",
      message: [{ type: "text", data: { text: "/stat" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    expect(lastReply()).toBe("本群暂无统计数据。");
  });

  it("throttles rapid repeated /stat queries in same group (Review Focus 5)", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "/stat",
      message: [{ type: "text", data: { text: "/stat" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () =>
        Effect.succeed({
          groupTotal: 10,
          rows: [
            {
              userId: 20001,
              nickname: "Alice",
              totalCount: 10,
              mediaCount: 0,
              linkCount: 0,
              interactionCount: 0,
            },
          ],
        }),
      getUserStats: () => Effect.die("not called"),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.succeed(Buffer.from("png")),
    });

    const layer = Layer.mergeAll(
      Layer.succeed(StatsRepository, mockRepo),
      Layer.succeed(StatsRenderer, mockRenderer),
      StatsCooldown.layer,
    );

    // Call 1 passes, Call 2 immediately: throttled
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* handleStatsCommand(item);
        expect(getReplies().length).toBe(1);

        yield* handleStatsCommand(item);
        expect(getReplies().length).toBe(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("handles /me command and quotes formatted personal stats", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "/me",
      message: [{ type: "text", data: { text: "/me" } }],
      self_id: 123456,
      user_id: 20001,
      sender: { user_id: 20001, nickname: "Alice" },
    });

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
          stats30d: {
            totalCount: 200,
            mediaCount: 50,
            linkCount: 20,
            interactionCount: 10,
            rank: 2,
          },
          statsAll: {
            totalCount: 800,
            mediaCount: 200,
            linkCount: 80,
            interactionCount: 40,
            rank: 1,
          },
        }),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("not called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    const reply = lastReply();
    expect(typeof reply).toBe("string");
    const text = reply as string;
    expect(text).toContain("个人群聊统计 (近 30 天 / 历史累计)");
    expect(text).toContain("消息总计：200 / 800 条 (排名第 2 / 1)");
    expect(text).toContain("媒体消息：50 / 200 条");
    expect(text).toContain("包含链接：20 / 80 条");
    expect(text).toContain("互动次数：10 / 40 次");
  });

  it("handles /me for user with 0 messages (Review Focus 3)", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "/me",
      message: [{ type: "text", data: { text: "/me" } }],
      self_id: 123456,
      user_id: 99999,
      sender: { user_id: 99999, nickname: "Newbie" },
    });

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
          stats30d: {
            totalCount: 0,
            mediaCount: 0,
            linkCount: 0,
            interactionCount: 0,
            rank: null,
          },
          statsAll: {
            totalCount: 0,
            mediaCount: 0,
            linkCount: 0,
            interactionCount: 0,
            rank: null,
          },
        }),
    });

    const mockRenderer = StatsRenderer.of({
      renderLeaderboard: () => Effect.die("not called"),
    });

    await Effect.runPromise(
      handleStatsCommand(item).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(StatsRepository, mockRepo),
            Layer.succeed(StatsRenderer, mockRenderer),
            StatsCooldown.layer,
          ),
        ),
      ),
    );

    const text = lastReply() as string;
    expect(text).toContain("排名第 - / -");
    expect(text).toContain("消息总计：0 / 0 条");
  });
});
