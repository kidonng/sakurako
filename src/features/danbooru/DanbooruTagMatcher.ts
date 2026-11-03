/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql";

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
      deduplicated.join(" ") !==
      tokens.map((t) => t.toLowerCase()).join(" ");
    return { tags: deduplicated, isModified };
  });

  return DanbooruTagMatcher.of({
    matchTag,
    matchQuery,
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

      return DanbooruTagMatcher.of({
        matchTag,
        matchQuery,
      });
    }),
  );

  static readonly live = (options?: { readonly filename?: string }) => {
    const filename = options?.filename ?? "assets/danbooru-tags.sqlite";
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
