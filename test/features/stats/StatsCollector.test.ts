import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotGroupMessageEvent, OneBotNoticeEvent } from "@snowluma/sdk/types";
import { Effect } from "effect";
import {
  handleStatsMessage,
  handleStatsNotice,
} from "../../../src/features/stats/StatsCollector.ts";
import {
  StatsRepository,
} from "../../../src/features/stats/StatsRepository.ts";
import type {
  IncomingMessage,
  IncomingNotice,
} from "../../../src/SnowLuma.ts";

describe("StatsCollector", () => {
  it("ignores self messages", async () => {
    let recorded = false;
    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => {
        recorded = true;
        return Effect.void;
      },
      recordInteraction: () => Effect.void,
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    const item: IncomingMessage = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "message_sent",
        message_type: "group",
        sub_type: "normal",
        message_id: 1,
        group_id: 10001,
        user_id: 123456,
        message: "hello",
        raw_message: "hello",
        font: 0,
        sender: { user_id: 123456, nickname: "bot" },
      } as OneBotGroupMessageEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    await Effect.runPromise(
      handleStatsMessage(item).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );
    expect(recorded).toBe(false);
  });

  it("processes group message with profile update and message classification", async () => {
    let savedProfile: { groupId: number; userId: number; nickname: string } | null = null;
    let savedMessage: {
      groupId: number;
      userId: number;
      counts: { hasMedia: boolean; hasLink: boolean };
    } | null = null;

    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: (groupId, userId, _date, counts) => {
        savedMessage = { groupId, userId, counts };
        return Effect.void;
      },
      recordInteraction: () => Effect.void,
      upsertProfile: (groupId, userId, nickname) => {
        savedProfile = { groupId, userId, nickname };
        return Effect.void;
      },
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    // Review Focus 1: combined media + link message
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
        message: [
          { type: "text", data: { text: "check https://example.com" } },
          { type: "image", data: { file: "test.png" } },
        ],
        raw_message: "check https://example.com [CQ:image,file=test.png]",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice", card: "AliceInGroup" },
      } as OneBotGroupMessageEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    await Effect.runPromise(
      handleStatsMessage(item).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );

    expect(savedProfile as unknown).toEqual({
      groupId: 10001,
      userId: 20001,
      nickname: "AliceInGroup",
    });
    expect(savedMessage as unknown).toEqual({
      groupId: 10001,
      userId: 20001,
      counts: { hasMedia: true, hasLink: true },
    });
  });

  it("processes group poke notice", async () => {
    let interactionRecord: { groupId: number; userId: number } | null = null;
    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: (groupId, userId, _date) => {
        interactionRecord = { groupId, userId };
        return Effect.void;
      },
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    const item: IncomingNotice = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        group_id: 10001,
        user_id: 20001,
        target_id: 30001,
      } as unknown as OneBotNoticeEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotNoticeEvent>,
    };

    await Effect.runPromise(
      handleStatsNotice(item).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );

    expect(interactionRecord as unknown).toEqual({
      groupId: 10001,
      userId: 20001,
    });
  });

  it("processes reaction addition notice and ignores removal (Review Focus 2)", async () => {
    let interactionCount = 0;
    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: () => {
        interactionCount += 1;
        return Effect.void;
      },
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    const addNotice: IncomingNotice = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "add",
        group_id: 10001,
        user_id: 20001,
      } as unknown as OneBotNoticeEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotNoticeEvent>,
    };

    const removeNotice: IncomingNotice = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "remove",
        group_id: 10001,
        user_id: 20001,
      } as unknown as OneBotNoticeEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotNoticeEvent>,
    };

    await Effect.runPromise(
      handleStatsNotice(addNotice).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );
    expect(interactionCount).toBe(1);

    await Effect.runPromise(
      handleStatsNotice(removeNotice).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );
    expect(interactionCount).toBe(1); // Not incremented on removal
  });
  it("processes reaction addition carrying only operator_id", async () => {
    let recordedUserId: number | null = null;
    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.void,
      recordInteraction: (_groupId, userId) => {
        recordedUserId = userId;
        return Effect.void;
      },
      upsertProfile: () => Effect.void,
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

    const notice: IncomingNotice = {
      event: {
        time: 1700000000,
        self_id: 123456,
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "add",
        group_id: 10001,
        operator_id: 30003,
      } as unknown as OneBotNoticeEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotNoticeEvent>,
    };

    await Effect.runPromise(
      handleStatsNotice(notice).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );
    expect(recordedUserId as unknown).toBe(30003);
  });


  it("isolates errors when database fails", async () => {
    const mockRepo = StatsRepository.of({
      initSchema: Effect.void,
      recordMessage: () => Effect.die("DB down"),
      recordInteraction: () => Effect.die("DB down"),
      upsertProfile: () => Effect.die("DB down"),
      getLeaderboard: () => Effect.succeed({ groupTotal: 0, rows: [] }),
      getUserStats: () =>
        Effect.succeed({
          userId: 0,
          nickname: "",
          stats30d: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
          statsAll: { totalCount: 0, mediaCount: 0, linkCount: 0, interactionCount: 0, rank: null },
        }),
    });

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
        message: "hello",
        raw_message: "hello",
        font: 0,
        sender: { user_id: 20001, nickname: "Alice" },
      } as OneBotGroupMessageEvent,
      context: {} as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
    };

    // Should complete cleanly without rejecting
    await Effect.runPromise(
      handleStatsMessage(item).pipe(
        Effect.provideService(StatsRepository, mockRepo),
      ),
    );
  });
});
