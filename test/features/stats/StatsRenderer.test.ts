import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import sharp from "sharp";
import {
  type RenderLeaderboardOptions,
  StatsRenderer,
} from "../../../src/features/stats/StatsRenderer.tsx";

describe("StatsRenderer", () => {
  it("renders leaderboard to PNG buffer with correct magic bytes", async () => {
    const options: RenderLeaderboardOptions = {
      groupName: "测试群 (10001)",
      timeLabel: "最近 30 天",
      data: {
        groupTotal: 1500,
        rows: [
          {
            userId: 1001,
            nickname: "Alice",
            totalCount: 800,
            mediaCount: 300,
            linkCount: 100,
            interactionCount: 50,
          },
          {
            userId: 1002,
            nickname: "Bob",
            totalCount: 700,
            mediaCount: 200,
            linkCount: 80,
            interactionCount: 40,
          },
        ],
      },
    };

    const program = Effect.gen(function* () {
      const renderer = yield* StatsRenderer;
      const pngBuffer = yield* renderer.renderLeaderboard(options);

      expect(pngBuffer).toBeInstanceOf(Buffer);
      expect(pngBuffer.length).toBeGreaterThan(1000);
      // PNG magic number: 0x89 0x50 0x4E 0x47
      expect(pngBuffer[0]).toBe(0x89);
      expect(pngBuffer[1]).toBe(0x50);
      expect(pngBuffer[2]).toBe(0x4e);
      expect(pngBuffer[3]).toBe(0x47);

      const metadata = yield* Effect.promise(() => sharp(pngBuffer).metadata());
      expect(metadata.width).toBe(1240);
      expect(metadata.height).toBeGreaterThan(0);
    });

    await Effect.runPromise(program.pipe(Effect.provide(StatsRenderer.layer)));
  });

  it("renders leaderboard with extremely long nickname and missing nickname gracefully", async () => {
    const options: RenderLeaderboardOptions = {
      timeLabel: "今日",
      data: {
        groupTotal: 9999,
        rows: [
          {
            userId: 2001,
            nickname:
              "A very very long nickname that exceeds normal column width and requires ellipsis truncation",
            totalCount: 5000,
            mediaCount: 2000,
            linkCount: 500,
            interactionCount: 300,
          },
          {
            userId: 2002,
            nickname: "",
            totalCount: 4999,
            mediaCount: 1500,
            linkCount: 400,
            interactionCount: 200,
          },
        ],
      },
    };

    const program = Effect.gen(function* () {
      const renderer = yield* StatsRenderer;
      const pngBuffer = yield* renderer.renderLeaderboard(options);

      expect(pngBuffer).toBeInstanceOf(Buffer);
      const metadata = yield* Effect.promise(() => sharp(pngBuffer).metadata());
      expect(metadata.width).toBe(1240);
      expect(metadata.height).toBeGreaterThan(0);
    });

    await Effect.runPromise(program.pipe(Effect.provide(StatsRenderer.layer)));
  });
});
