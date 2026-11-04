/* oxlint-disable effecttsgo/unstable-api-usage */
import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";

export const DANBOORU_TAGS_DB_PATH = "assets/danbooru-tags.sqlite";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql";

export function lookupDanbooruTagTranslations(
  tags: readonly string[],
  dbSource: Database | string = DANBOORU_TAGS_DB_PATH,
): Map<string, string> {
  const result = new Map<string, string>();
  const validTags = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (validTags.length === 0) {
    return result;
  }

  const isStringPath = typeof dbSource === "string";
  try {
    const db = isStringPath
      ? new Database(dbSource, { readonly: true })
      : dbSource;
    try {
      const placeholders = validTags.map(() => "?").join(",");
      const rows = db
        .query<{ name: string; cn_name: string | null }, string[]>(
          `SELECT name, cn_name FROM tags WHERE name IN (${placeholders})`,
        )
        .all(...validTags);

      for (const row of rows) {
        if (row.cn_name && row.cn_name.trim().length > 0) {
          result.set(row.name, row.cn_name.trim());
        }
      }
    } finally {
      if (isStringPath) {
        db.close();
      }
    }
  } catch {
    // Ignore and return partial or empty map on error
  }

  return result;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev, dp[j]!, dp[j - 1]!) + 1;
      }
      prev = temp;
    }
  }
  return dp[n]!;
}

function makeFallbackTagMatcher() {
  const matchTag = (word: string) => {
    const normalized = word.trim().toLowerCase();
    if (/^[a-z0-9_:-]+$/i.test(normalized)) {
      return Effect.succeed(normalized);
    }
    return Effect.succeed(undefined as string | undefined);
  };
  const matchQuery = Effect.fnUntraced(function* (rawQuery: string) {
    const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { tags: [], isModified: false };
    }

    const matchedList: string[] = [];
    for (const token of tokens) {
      const tag = yield* matchTag(token);
      if (tag) {
        matchedList.push(tag);
      }
    }

    const deduplicated = Array.from(new Set(matchedList));
    const isModified =
      deduplicated.join(" ") !== tokens.map((t) => t.toLowerCase()).join(" ");
    return { tags: deduplicated, isModified };
  });
    const getTagTranslations = () =>
      Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>);

  return DanbooruTagMatcher.of({
    matchTag,
    matchQuery,
    getTagTranslations,
  });
}

export class DanbooruTagMatcher extends Context.Service<
  DanbooruTagMatcher,
  {
    readonly matchTag: (word: string) => Effect.Effect<string | undefined>;
    readonly matchQuery: (rawQuery: string) => Effect.Effect<{
      readonly tags: readonly string[];
      readonly isModified: boolean;
    }>;
    readonly getTagTranslations: (
      tags: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>>;
  }
>()("sakurako/danbooru/DanbooruTagMatcher") {
  static readonly layer = Layer.effect(
    DanbooruTagMatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const dbPath = DANBOORU_TAGS_DB_PATH;
      const dbExists = yield* fs
        .exists(dbPath)
        .pipe(Effect.orElseSucceed(() => false));

      const matchTag = Effect.fnUntraced(function* (word: string) {
        const normalized = word.trim().toLowerCase();
        if (!normalized) return undefined;

        if (!dbExists) {
          if (/^[a-z0-9_:-]+$/i.test(normalized)) {
            return normalized;
          }
          return undefined;
        }

        // 1. Exact match on name or cn_name
        const exactRows = yield* sql<{ name: string; post_count: number }>`
          SELECT name, post_count FROM tags
          WHERE name = ${normalized} COLLATE NOCASE OR cn_name = ${normalized}
          ORDER BY post_count DESC
          LIMIT 1
        `.pipe(Effect.orElseSucceed(() => []));

        if (exactRows.length > 0 && exactRows[0]) {
          return exactRows[0].name;
        }

        // 2. Prefix match
        const prefixPattern = `${normalized}%`;
        const prefixRows = yield* sql<{ name: string; post_count: number }>`
          SELECT name, post_count FROM tags
          WHERE name LIKE ${prefixPattern} OR cn_name LIKE ${prefixPattern}
          ORDER BY post_count DESC
          LIMIT 20
        `.pipe(Effect.orElseSucceed(() => []));

        if (prefixRows.length > 0 && prefixRows[0]) {
          return prefixRows[0].name;
        }

        // 3. Typo / compound / substring match for English words
        if (/^[a-z0-9_]+$/i.test(normalized)) {
          const parts = normalized.split("_").filter(Boolean);
          const normSorted = parts.slice().sort().join("_");

          let candidateRows: readonly {
            readonly name: string;
            readonly post_count: number;
          }[];

          if (parts.length > 1 && parts[0] && parts[1]) {
            const p0 = `%${parts[0]}%`;
            const p1 = `%${parts[1]}%`;
            candidateRows = yield* sql<{
              name: string;
              post_count: number;
            }>`
              SELECT name, post_count FROM tags
              WHERE (name LIKE ${p0} AND name LIKE ${p1})
                 OR name LIKE ${"%" + normalized + "%"}
              ORDER BY post_count DESC
              LIMIT 50
            `.pipe(Effect.orElseSucceed(() => []));
          } else {
            const containsPattern = `%${normalized}%`;
            candidateRows = yield* sql<{
              name: string;
              post_count: number;
            }>`
              SELECT name, post_count FROM tags
              WHERE name LIKE ${containsPattern}
              ORDER BY post_count DESC
              LIMIT 50
            `.pipe(Effect.orElseSucceed(() => []));
          }

          if (candidateRows.length > 0) {
            let bestTag: string | undefined = undefined;
            let minDistance = Number.POSITIVE_INFINITY;
            let maxPostCount = -1;

            for (const row of candidateRows) {
              const candLower = row.name.toLowerCase();
              const directDist = levenshtein(normalized, candLower);
              const candParts = candLower.split("_").filter(Boolean);
              const candSorted = candParts.sort().join("_");
              const sortedDist = levenshtein(normSorted, candSorted);
              const dist = Math.min(directDist, sortedDist);

              const threshold = Math.max(1, Math.floor(normalized.length / 3));
              if (dist <= threshold) {
                if (
                  dist < minDistance ||
                  (dist === minDistance && row.post_count > maxPostCount)
                ) {
                  minDistance = dist;
                  maxPostCount = row.post_count;
                  bestTag = row.name;
                }
              }
            }
            if (bestTag) {
              return bestTag;
            }
          }

          return normalized;
        }

        return undefined;
      });

      const matchQuery = Effect.fnUntraced(function* (rawQuery: string) {
        const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
          return { tags: [], isModified: false };
        }

        const matchedList: string[] = [];
        for (const token of tokens) {
          const tag = yield* matchTag(token);
          if (tag) {
            matchedList.push(tag);
          }
        }

        const deduplicated = Array.from(new Set(matchedList));
        const isModified =
          deduplicated.join(" ") !==
          tokens.map((t) => t.toLowerCase()).join(" ");
        return { tags: deduplicated, isModified };
      });
      const getTagTranslations = Effect.fnUntraced(function* (
        tags: readonly string[],
      ) {
        const validTags = tags
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        const translationMap = new Map<string, string>();
        if (validTags.length === 0 || !dbExists) {
          return translationMap as ReadonlyMap<string, string>;
        }

        const rows = yield* sql<{ name: string; cn_name: string | null }>`
          SELECT name, cn_name FROM tags
          WHERE name IN ${sql.in(validTags)}
        `.pipe(Effect.orElseSucceed(() => []));

        for (const row of rows) {
          if (row.cn_name && row.cn_name.trim().length > 0) {
            translationMap.set(row.name, row.cn_name.trim());
          }
        }
        return translationMap as ReadonlyMap<string, string>;
      });

      return DanbooruTagMatcher.of({
        matchTag,
        matchQuery,
        getTagTranslations,
      });
    }),
  );

  static readonly live = (options?: { readonly filename?: string }) => {
    const filename = options?.filename ?? DANBOORU_TAGS_DB_PATH;
    return Layer.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        const exists = yield* fs
          .exists(filename)
          .pipe(Effect.orElseSucceed(() => false));

        if (!exists) {
          yield* Effect.logWarning(
            `Danbooru tag database not found at ${filename}, running in fallback mode. Run 'bun run download-tags' to enable full tag translation.`,
          );
          return Layer.succeed(DanbooruTagMatcher, makeFallbackTagMatcher());
        }

        const sqliteLive = SqliteClient.layer({
          filename,
          readonly: true,
        });
        return DanbooruTagMatcher.layer.pipe(Layer.provide(sqliteLive));
      }),
    );
  };
}
