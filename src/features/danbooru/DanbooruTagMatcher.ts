/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql";

export function levenshtein(a: string, b: string): number {
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

export class DanbooruTagMatcher extends Context.Service<
  DanbooruTagMatcher,
  {
    readonly matchTag: (word: string) => Effect.Effect<string | undefined>;
    readonly matchQuery: (rawQuery: string) => Effect.Effect<{
      readonly tags: readonly string[];
      readonly isModified: boolean;
    }>;
  }
>()("sakurako/danbooru/DanbooruTagMatcher") {
  static readonly layer = Layer.effect(
    DanbooruTagMatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const dbPath = "assets/danbooru-tags.sqlite";
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

        if (/^[a-z0-9_]+$/i.test(normalized)) {
          const containsPattern = `%${normalized}%`;
          const candidateRows = yield* sql<{
            name: string;
            post_count: number;
          }>`
            SELECT name, post_count FROM tags
            WHERE name LIKE ${containsPattern}
            ORDER BY post_count DESC
            LIMIT 50
          `.pipe(Effect.orElseSucceed(() => []));

          if (candidateRows.length > 0) {
            let bestTag: string | undefined = undefined;
            let minDistance = Number.POSITIVE_INFINITY;
            let maxPostCount = -1;

            for (const row of candidateRows) {
              const dist = levenshtein(normalized, row.name.toLowerCase());
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

      return DanbooruTagMatcher.of({
        matchTag,
        matchQuery,
      });
    }),
  );
}
