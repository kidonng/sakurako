/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { StatsRepository } from "../../../src/features/stats/StatsRepository.ts";

const makeTestLayer = () => {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  return StatsRepository.layer.pipe(Layer.provide(sqliteLayer));
};

describe("StatsRepository", () => {
  it("initializes schema and records message counts", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      yield* repo.recordMessage(1001, 2001, "2026-11-02", {
        hasMedia: true,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2001, "2026-11-02", {
        hasMedia: false,
        hasLink: true,
      });

      const lb = yield* repo.getLeaderboard(1001);
      expect(lb.groupTotal).toBe(2);
      expect(lb.rows.length).toBe(1);
      expect(lb.rows[0]?.userId).toBe(2001);
      expect(lb.rows[0]?.totalCount).toBe(2);
      expect(lb.rows[0]?.mediaCount).toBe(1);
      expect(lb.rows[0]?.linkCount).toBe(1);
      expect(lb.rows[0]?.interactionCount).toBe(0);
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });

  it("records interaction count", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      yield* repo.recordInteraction(1001, 2002, "2026-11-02");
      yield* repo.recordInteraction(1001, 2002, "2026-11-02");

      const lb = yield* repo.getLeaderboard(1001);
      expect(lb.rows.length).toBe(1);
      expect(lb.rows[0]?.userId).toBe(2002);
      expect(lb.rows[0]?.totalCount).toBe(0);
      expect(lb.rows[0]?.interactionCount).toBe(2);
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });

  it("upserts profile and joins nickname in leaderboard", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      yield* repo.upsertProfile(1001, 2001, "Sakura");
      yield* repo.recordMessage(1001, 2001, "2026-11-02", {
        hasMedia: false,
        hasLink: false,
      });

      const lb = yield* repo.getLeaderboard(1001);
      expect(lb.rows[0]?.nickname).toBe("Sakura");

      // Update nickname
      yield* repo.upsertProfile(1001, 2001, "Sakurako");
      const lb2 = yield* repo.getLeaderboard(1001);
      expect(lb2.rows[0]?.nickname).toBe("Sakurako");
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });

  it("filters leaderboard by startDate (last 30 days)", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      // 40 days ago
      yield* repo.recordMessage(1001, 2001, "2026-09-20", {
        hasMedia: false,
        hasLink: false,
      });
      // Recent message
      yield* repo.recordMessage(1001, 2002, "2026-11-01", {
        hasMedia: false,
        hasLink: false,
      });

      const lbAll = yield* repo.getLeaderboard(1001);
      expect(lbAll.groupTotal).toBe(2);
      expect(lbAll.rows.length).toBe(2);

      const lb30d = yield* repo.getLeaderboard(1001, "2026-10-03");
      expect(lb30d.groupTotal).toBe(1);
      expect(lb30d.rows.length).toBe(1);
      expect(lb30d.rows[0]?.userId).toBe(2002);
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });

  it("queries user personal stats with ranks across 30d and all-time", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      yield* repo.upsertProfile(1001, 2001, "Alice");
      yield* repo.upsertProfile(1001, 2002, "Bob");

      // Alice: 5 messages all-time, 2 in last 30d
      yield* repo.recordMessage(1001, 2001, "2026-09-01", {
        hasMedia: false,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2001, "2026-09-02", {
        hasMedia: false,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2001, "2026-09-03", {
        hasMedia: false,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2001, "2026-11-01", {
        hasMedia: true,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2001, "2026-11-02", {
        hasMedia: false,
        hasLink: true,
      });

      // Bob: 3 messages, all in last 30d
      yield* repo.recordMessage(1001, 2002, "2026-11-01", {
        hasMedia: false,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2002, "2026-11-01", {
        hasMedia: false,
        hasLink: false,
      });
      yield* repo.recordMessage(1001, 2002, "2026-11-02", {
        hasMedia: false,
        hasLink: false,
      });

      const statsAlice = yield* repo.getUserStats(1001, 2001, "2026-10-03");
      expect(statsAlice.nickname).toBe("Alice");
      expect(statsAlice.statsAll.totalCount).toBe(5);
      expect(statsAlice.statsAll.rank).toBe(1); // Alice #1 all-time (5 vs 3)
      expect(statsAlice.stats30d.totalCount).toBe(2);
      expect(statsAlice.stats30d.rank).toBe(2); // Bob #1 in 30d (3 vs 2), Alice #2
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });

  it("handles user with 0 messages gracefully (Review Focus 3)", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* StatsRepository;
      yield* repo.initSchema;

      const stats = yield* repo.getUserStats(1001, 9999, "2026-10-03");
      expect(stats.userId).toBe(9999);
      expect(stats.stats30d.totalCount).toBe(0);
      expect(stats.stats30d.rank).toBeNull();
      expect(stats.statsAll.totalCount).toBe(0);
      expect(stats.statsAll.rank).toBeNull();
    });

    await Effect.runPromise(program.pipe(Effect.provide(makeTestLayer())));
  });
});
