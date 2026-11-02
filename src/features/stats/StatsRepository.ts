/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Clock, Context, Effect, Layer } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

interface MemberStatsRow {
  readonly userId: number;
  readonly nickname: string;
  readonly totalCount: number;
  readonly mediaCount: number;
  readonly linkCount: number;
  readonly interactionCount: number;
}

export interface LeaderboardResult {
  readonly groupTotal: number;
  readonly rows: readonly MemberStatsRow[];
}

interface UserPeriodStats {
  readonly totalCount: number;
  readonly mediaCount: number;
  readonly linkCount: number;
  readonly interactionCount: number;
  readonly rank: number | null;
}

export interface UserStatsResult {
  readonly userId: number;
  readonly nickname: string;
  readonly stats30d: UserPeriodStats;
  readonly statsAll: UserPeriodStats;
}

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

      const getLeaderboard = Effect.fnUntraced(function* (
        groupId: number,
        startDate?: string,
        limit = 15,
      ) {
        const dateCond = startDate ? sql`AND date >= ${startDate}` : sql``;

        const totalRes = yield* sql<{ readonly total: number }>`
          SELECT COALESCE(SUM(total_count), 0) AS total
          FROM member_daily_stats
          WHERE group_id = ${groupId} ${dateCond};
        `;
        const groupTotal = totalRes[0]?.total ?? 0;

        const rowsRes = yield* sql<{
          readonly user_id: number;
          readonly nickname: string;
          readonly total_count: number;
          readonly media_count: number;
          readonly link_count: number;
          readonly interaction_count: number;
        }>`
          SELECT
            s.user_id,
            COALESCE(p.nickname, CAST(s.user_id AS TEXT)) AS nickname,
            SUM(s.total_count) AS total_count,
            SUM(s.media_count) AS media_count,
            SUM(s.link_count) AS link_count,
            SUM(s.interaction_count) AS interaction_count
          FROM member_daily_stats s
          LEFT JOIN member_profiles p
            ON s.group_id = p.group_id AND s.user_id = p.user_id
          WHERE s.group_id = ${groupId} ${dateCond}
          GROUP BY s.user_id
          ORDER BY total_count DESC, s.user_id ASC
          LIMIT ${limit};
        `;

        const rows: MemberStatsRow[] = rowsRes.map((r) => ({
          userId: Number(r.user_id),
          nickname: String(r.nickname),
          totalCount: Number(r.total_count),
          mediaCount: Number(r.media_count),
          linkCount: Number(r.link_count),
          interactionCount: Number(r.interaction_count),
        }));

        return { groupTotal: Number(groupTotal), rows };
      });

      const getUserStats = Effect.fnUntraced(function* (
        groupId: number,
        userId: number,
        startDate30d: string,
      ) {
        const profileRes = yield* sql<{ readonly nickname: string }>`
          SELECT nickname FROM member_profiles
          WHERE group_id = ${groupId} AND user_id = ${userId};
        `;
        const nickname = profileRes[0]?.nickname ?? String(userId);

        const fetchPeriod = (startDate?: string) =>
          Effect.gen(function* () {
            const dateClause = startDate
              ? sql`AND date >= ${startDate}`
              : sql``;
            const sumRes = yield* sql<{
              readonly total_count: number;
              readonly media_count: number;
              readonly link_count: number;
              readonly interaction_count: number;
            }>`
              SELECT
                COALESCE(SUM(total_count), 0) AS total_count,
                COALESCE(SUM(media_count), 0) AS media_count,
                COALESCE(SUM(link_count), 0) AS link_count,
                COALESCE(SUM(interaction_count), 0) AS interaction_count
              FROM member_daily_stats
              WHERE group_id = ${groupId} AND user_id = ${userId} ${dateClause};
            `;
            const totalCount = Number(sumRes[0]?.total_count ?? 0);
            const mediaCount = Number(sumRes[0]?.media_count ?? 0);
            const linkCount = Number(sumRes[0]?.link_count ?? 0);
            const interactionCount = Number(sumRes[0]?.interaction_count ?? 0);

            let rank: number | null = null;
            if (totalCount > 0) {
              const rankRes = yield* sql<{ readonly higher_count: number }>`
                SELECT COUNT(*) AS higher_count FROM (
                  SELECT user_id, SUM(total_count) AS user_total
                  FROM member_daily_stats
                  WHERE group_id = ${groupId} ${dateClause}
                  GROUP BY user_id
                  HAVING user_total > ${totalCount}
                );
              `;
              rank = Number(rankRes[0]?.higher_count ?? 0) + 1;
            }

            return {
              totalCount,
              mediaCount,
              linkCount,
              interactionCount,
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
