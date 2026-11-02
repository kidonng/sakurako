/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type {
  OneBotGroupMessageEvent,
  OneBotNoticeEvent,
} from "@snowluma/sdk/types";
import { Effect, Layer } from "effect";
import {
  handleStatsCollectorMessage,
  handleStatsCollectorNotice,
} from "../../../src/index.ts";
import { handleStatsCommand } from "../../../src/features/stats/StatsCommand.ts";
import { StatsCooldown } from "../../../src/features/stats/StatsCooldown.ts";
import { StatsRenderer } from "../../../src/features/stats/StatsRenderer.ts";
import { StatsRepository } from "../../../src/features/stats/StatsRepository.ts";
import type { IncomingMessage, IncomingNotice } from "../../../src/SnowLuma.ts";

describe("StatsIntegration", () => {
  it("records events and responds to /me and /stat commands end-to-end", async () => {
    const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
    const repoLayer = StatsRepository.layer.pipe(Layer.provide(sqliteLayer));
    const fullLayer = Layer.mergeAll(
      repoLayer,
      StatsRenderer.layer,
      StatsCooldown.layer,
    );

    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      // 1. User 1001 sends a message with an image
      const msgEvent: IncomingMessage = {
        event: {
          time: 1700000000,
          self_id: 123456,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 1001,
          group_id: 20002,
          user_id: 1001,
          message: [
            { type: "text", data: { text: "hello" } },
            { type: "image", data: { file: "pic.jpg" } },
          ],
          raw_message: "hello [CQ:image,file=pic.jpg]",
          font: 0,
          sender: { user_id: 1001, nickname: "Alice", card: "AliceCard" },
        } as OneBotGroupMessageEvent,
        context: {} as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
      };
      yield* handleStatsCollectorMessage(msgEvent);

      // 2. User 1002 pokes someone
      const pokeEvent: IncomingNotice = {
        event: {
          time: 1700000005,
          self_id: 123456,
          post_type: "notice",
          notice_type: "notify",
          sub_type: "poke",
          group_id: 20002,
          user_id: 1002,
          target_id: 1001,
        } as unknown as OneBotNoticeEvent,
        context: {} as SnowLumaEventContextWithQuote<OneBotNoticeEvent>,
      };
      yield* handleStatsCollectorNotice(pokeEvent);

      // 3. User 1001 executes /me
      let quotedMeText: unknown = null;
      const meMsg: IncomingMessage = {
        event: {
          time: 1700000010,
          self_id: 123456,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 1002,
          group_id: 20002,
          user_id: 1001,
          message: [{ type: "text", data: { text: "/me" } }],
          raw_message: "/me",
          font: 0,
          sender: { user_id: 1001, nickname: "Alice", card: "AliceCard" },
        } as OneBotGroupMessageEvent,
        context: {
          quote: (payload: unknown) => {
            quotedMeText = payload;
            return Promise.resolve({} as never);
          },
        } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
      };
      yield* handleStatsCommand(meMsg);

      expect(typeof quotedMeText).toBe("string");
      const meText = quotedMeText as string;
      expect(meText).toContain("个人群聊统计");
      expect(meText).toContain("消息总计：1 / 1 条 (排名第 1 / 1)");
      expect(meText).toContain("媒体消息：1 / 1 条");

      // 4. User 1001 executes /stat
      let quotedStatPayload: unknown = null;
      const statMsg: IncomingMessage = {
        event: {
          time: 1700000015,
          self_id: 123456,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 1003,
          group_id: 20002,
          user_id: 1001,
          message: [{ type: "text", data: { text: "/stat" } }],
          raw_message: "/stat",
          font: 0,
          sender: { user_id: 1001, nickname: "Alice", card: "AliceCard" },
        } as OneBotGroupMessageEvent,
        context: {
          quote: (payload: unknown) => {
            quotedStatPayload = payload;
            return Promise.resolve({} as never);
          },
        } as unknown as SnowLumaEventContextWithQuote<OneBotGroupMessageEvent>,
      };
      yield* handleStatsCommand(statMsg);

      expect(quotedStatPayload).toBeDefined();
      const payloadStr = JSON.stringify(quotedStatPayload);
      expect(payloadStr).toContain("base64://");
    });

    await Effect.runPromise(program.pipe(Effect.provide(fullLayer)));
  });
});
