/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient, SqlSchema } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
const MemberStatsRow = Schema.Struct({
  userId: Schema.Finite,
  nickname: Schema.String,
  totalCount: Schema.Finite,
  mediaCount: Schema.Finite,
  linkCount: Schema.Finite,
  interactionCount: Schema.Finite,
});

export const LeaderboardResult = Schema.Struct({
  groupTotal: Schema.Finite,
  rows: Schema.Array(MemberStatsRow),
});
export type LeaderboardResult = typeof LeaderboardResult.Type;

const UserPeriodStats = Schema.Struct({
  totalCount: Schema.Finite,
  mediaCount: Schema.Finite,
  linkCount: Schema.Finite,
  interactionCount: Schema.Finite,
  rank: Schema.NullOr(Schema.Finite),
});

export const UserStatsResult = Schema.Struct({
  userId: Schema.Finite,
  nickname: Schema.String,
  stats30d: UserPeriodStats,
  statsAll: UserPeriodStats,
});
export type UserStatsResult = typeof UserStatsResult.Type;

export class StatsRepository extends Context.Service<
  StatsRepository,
  {
    readonly initSchema: Effect.Effect<
      void,
      SqlError | Migrator.MigrationError
    >;
    readonly recordMessage: (
      groupId: number,
      userId: number,
      date: string,
      counts: { readonly hasMedia: boolean; readonly hasLink: boolean },
    ) => Effect.Effect<void, SqlError>;
    readonly recordInteraction: (
      groupId: number,
      userId: number,
      date: string,
    ) => Effect.Effect<void, SqlError>;
    readonly upsertProfile: (
      groupId: number,
      userId: number,
      nickname: string,
    ) => Effect.Effect<void, SqlError>;
    readonly getLeaderboard: (
      groupId: number,
      startDate?: string,
      limit?: number,
    ) => Effect.Effect<LeaderboardResult, SqlError>;
    readonly getUserStats: (
      groupId: number,
      userId: number,
      startDate30d: string,
    ) => Effect.Effect<UserStatsResult, SqlError>;
  }
>()("sakurako/StatsRepository") {
  static readonly layer = Layer.effect(
    StatsRepository,
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;

      const migrations = Migrator.fromRecord({
        "0001_initial": Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            CREATE TABLE IF NOT EXISTS member_daily_stats (
              group_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              date TEXT NOT NULL,
              total_count INTEGER NOT NULL DEFAULT 0,
              media_count INTEGER NOT NULL DEFAULT 0,
              link_count INTEGER NOT NULL DEFAULT 0,
              interaction_count INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (group_id, user_id, date)
            );
          `;
          yield* sql`
            CREATE INDEX IF NOT EXISTS idx_member_daily_stats_group_date
              ON member_daily_stats(group_id, date);
          `;
          yield* sql`
            CREATE TABLE IF NOT EXISTS member_profiles (
              group_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              nickname TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (group_id, user_id)
            );
          `;
        }),
      });

      const initSchema = SqliteMigrator.run({ loader: migrations }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.asVoid,
      );

      const recordMessage = Effect.fnUntraced(function* (
        groupId: number,
        userId: number,
        date: string,
        counts: { readonly hasMedia: boolean; readonly hasLink: boolean },
      ) {
        const mediaInc = counts.hasMedia ? 1 : 0;
        const linkInc = counts.hasLink ? 1 : 0;
        yield* sql`
          INSERT INTO member_daily_stats (
            group_id, user_id, date, total_count, media_count, link_count, interaction_count
          ) VALUES (
            ${groupId}, ${userId}, ${date}, 1, ${mediaInc}, ${linkInc}, 0
          )
          ON CONFLICT(group_id, user_id, date) DO UPDATE SET
            total_count = total_count + 1,
            media_count = media_count + ${mediaInc},
            link_count = link_count + ${linkInc};
        `;
      });

      const recordInteraction = Effect.fnUntraced(function* (
        groupId: number,
        userId: number,
        date: string,
      ) {
        yield* sql`
          INSERT INTO member_daily_stats (
            group_id, user_id, date, total_count, media_count, link_count, interaction_count
          ) VALUES (
            ${groupId}, ${userId}, ${date}, 0, 0, 0, 1
          )
          ON CONFLICT(group_id, user_id, date) DO UPDATE SET
            interaction_count = interaction_count + 1;
        `;
      });

      const upsertProfile = Effect.fnUntraced(function* (
        groupId: number,
        userId: number,
        nickname: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO member_profiles (group_id, user_id, nickname, updated_at)
          VALUES (${groupId}, ${userId}, ${nickname}, ${now})
          ON CONFLICT(group_id, user_id) DO UPDATE SET
            nickname = excluded.nickname,
            updated_at = excluded.updated_at;
        `;
      });

      const findGroupTotal = SqlSchema.findOne({
        Request: Schema.Struct({
          groupId: Schema.Finite,
          startDate: Schema.NullOr(Schema.String),
        }),
        Result: Schema.Struct({ total: Schema.Finite }),
        execute: ({ groupId, startDate }) => sql`
          SELECT COALESCE(SUM(total_count), 0) AS total
          FROM member_daily_stats
          WHERE group_id = ${groupId} ${startDate ? sql`AND date >= ${startDate}` : sql``};
        `,
      });

      const findLeaderboardRows = SqlSchema.findAll({
        Request: Schema.Struct({
          groupId: Schema.Finite,
          startDate: Schema.NullOr(Schema.String),
          limit: Schema.Finite,
        }),
        Result: MemberStatsRow,
        execute: ({ groupId, startDate, limit }) => sql`
          SELECT
            s.user_id AS userId,
            COALESCE(p.nickname, CAST(s.user_id AS TEXT)) AS nickname,
            SUM(s.total_count) AS totalCount,
            SUM(s.media_count) AS mediaCount,
            SUM(s.link_count) AS linkCount,
            SUM(s.interaction_count) AS interactionCount
          FROM member_daily_stats s
          LEFT JOIN member_profiles p
            ON s.group_id = p.group_id AND s.user_id = p.user_id
          WHERE s.group_id = ${groupId} ${startDate ? sql`AND date >= ${startDate}` : sql``}
          GROUP BY s.user_id
          ORDER BY totalCount DESC, s.user_id ASC
          LIMIT ${limit};
        `,
      });

      const findProfileNickname = SqlSchema.findOneOption({
        Request: Schema.Struct({
          groupId: Schema.Finite,
          userId: Schema.Finite,
        }),
        Result: Schema.Struct({ nickname: Schema.String }),
        execute: ({ groupId, userId }) => sql`
          SELECT nickname FROM member_profiles
          WHERE group_id = ${groupId} AND user_id = ${userId};
        `,
      });

      const PeriodSumRow = Schema.Struct({
        totalCount: Schema.Finite,
        mediaCount: Schema.Finite,
        linkCount: Schema.Finite,
        interactionCount: Schema.Finite,
      });

      const findPeriodSum = SqlSchema.findOne({
        Request: Schema.Struct({
          groupId: Schema.Finite,
          userId: Schema.Finite,
          startDate: Schema.NullOr(Schema.String),
        }),
        Result: PeriodSumRow,
        execute: ({ groupId, userId, startDate }) => sql`
          SELECT
            COALESCE(SUM(total_count), 0) AS totalCount,
            COALESCE(SUM(media_count), 0) AS mediaCount,
            COALESCE(SUM(link_count), 0) AS linkCount,
            COALESCE(SUM(interaction_count), 0) AS interactionCount
          FROM member_daily_stats
          WHERE group_id = ${groupId} AND user_id = ${userId} ${startDate ? sql`AND date >= ${startDate}` : sql``};
        `,
      });

      const findHigherRankCount = SqlSchema.findOne({
        Request: Schema.Struct({
          groupId: Schema.Finite,
          totalCount: Schema.Finite,
          startDate: Schema.NullOr(Schema.String),
        }),
        Result: Schema.Struct({ higherCount: Schema.Finite }),
        execute: ({ groupId, totalCount, startDate }) => sql`
          SELECT COUNT(*) AS higherCount FROM (
            SELECT user_id, SUM(total_count) AS user_total
            FROM member_daily_stats
            WHERE group_id = ${groupId} ${startDate ? sql`AND date >= ${startDate}` : sql``}
            GROUP BY user_id
            HAVING user_total > ${totalCount}
          );
        `,
      });

      const getLeaderboard = Effect.fnUntraced(function* (
        groupId: number,
        startDate?: string,
        limit = 15,
      ) {
        const { total: groupTotal } = yield* findGroupTotal({
          groupId,
          startDate: startDate ?? null,
        }).pipe(
          Effect.catchTags({
            SchemaError: Effect.die,
            NoSuchElementError: Effect.die,
          }),
        );

        const rows = yield* findLeaderboardRows({
          groupId,
          startDate: startDate ?? null,
          limit,
        }).pipe(Effect.catchTag("SchemaError", Effect.die));

        return { groupTotal, rows };
      });

      const getUserStats = Effect.fnUntraced(function* (
        groupId: number,
        userId: number,
        startDate30d: string,
      ) {
        const profileOpt = yield* findProfileNickname({
          groupId,
          userId,
        }).pipe(Effect.catchTag("SchemaError", Effect.die));
        const nickname = Option.isSome(profileOpt)
          ? profileOpt.value.nickname
          : String(userId);

        const fetchPeriod = (startDate?: string) =>
          Effect.gen(function* () {
            const sum = yield* findPeriodSum({
              groupId,
              userId,
              startDate: startDate ?? null,
            }).pipe(
              Effect.catchTags({
                SchemaError: Effect.die,
                NoSuchElementError: Effect.die,
              }),
            );

            let rank: number | null = null;
            if (sum.totalCount > 0) {
              const rankRes = yield* findHigherRankCount({
                groupId,
                totalCount: sum.totalCount,
                startDate: startDate ?? null,
              }).pipe(
                Effect.catchTags({
                  SchemaError: Effect.die,
                  NoSuchElementError: Effect.die,
                }),
              );
              rank = rankRes.higherCount + 1;
            }

            return {
              totalCount: sum.totalCount,
              mediaCount: sum.mediaCount,
              linkCount: sum.linkCount,
              interactionCount: sum.interactionCount,
              rank,
            };
          });

        const stats30d = yield* fetchPeriod(startDate30d);
        const statsAll = yield* fetchPeriod();

        return {
          userId,
          nickname,
          stats30d,
          statsAll,
        };
      });

      return StatsRepository.of({
        initSchema,
        recordMessage,
        recordInteraction,
        upsertProfile,
        getLeaderboard,
        getUserStats,
      });
    }),
  );
}
