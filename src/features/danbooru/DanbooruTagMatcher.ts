/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient, SqlSchema } from "effect/sql";

export const DANBOORU_TAGS_DB_PATH = "assets/danbooru-tags.sqlite";

const VALID_FALLBACK_TAG_REGEX = /^[a-z0-9_:-]+$/i;
const VALID_ENGLISH_WORD_REGEX = /^[a-z0-9_]+$/i;

const TagNameRow = Schema.Struct({
  name: Schema.String,
});

const TagCandidateRow = Schema.Struct({
  name: Schema.String,
  post_count: Schema.Finite,
});
type TagCandidateRow = typeof TagCandidateRow.Type;

const TagTranslationRow = Schema.Struct({
  name: Schema.String,
  cn_name: Schema.NullOr(Schema.String),
  category: Schema.Finite,
});

export function splitRawTags(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

export function cleanArtistName(name: string): string {
  const cleaned = name.replace(/\s*[（(]\s*画师\s*[）)]$/u, "").trim();
  return cleaned || name;
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

function pickBestFuzzyCandidate(
  normalized: string,
  candidateRows: readonly TagCandidateRow[],
): string | undefined {
  if (candidateRows.length === 0) {
    return undefined;
  }

  const normSorted = normalized.split("_").filter(Boolean).sort().join("_");
  const threshold = Math.max(1, Math.floor(normalized.length / 3));

  let bestTag: string | undefined;
  let minDistance = Number.POSITIVE_INFINITY;
  let maxPostCount = -1;

  for (const row of candidateRows) {
    const candLower = row.name.toLowerCase();
    const directDist = levenshtein(normalized, candLower);
    const candSorted = candLower.split("_").filter(Boolean).sort().join("_");
    const dist = Math.min(directDist, levenshtein(normSorted, candSorted));

    if (
      dist <= threshold &&
      (dist < minDistance ||
        (dist === minDistance && row.post_count > maxPostCount))
    ) {
      minDistance = dist;
      maxPostCount = row.post_count;
      bestTag = row.name;
    }
  }

  return bestTag;
}

function makeMatchQuery(
  matchTag: (word: string) => Effect.Effect<string | undefined>,
) {
  return Effect.fnUntraced(function* (rawQuery: string) {
    const tokens = splitRawTags(rawQuery);
    if (tokens.length === 0) {
      return [] as readonly string[];
    }

    const matched = new Set<string>();
    for (const token of tokens) {
      const tag = yield* matchTag(token);
      if (tag) {
        matched.add(tag);
      }
    }

    return Array.from(matched);
  });
}

function makeFallbackTagMatcher() {
  const matchTag = (word: string) => {
    const normalized = word.trim().toLowerCase();
    return Effect.succeed(
      VALID_FALLBACK_TAG_REGEX.test(normalized) ? normalized : undefined,
    );
  };
  const matchQuery = makeMatchQuery(matchTag);
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
    readonly matchQuery: (rawQuery: string) => Effect.Effect<readonly string[]>;
    readonly getTagTranslations: (
      tags: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>>;
  }
>()("sakurako/danbooru/DanbooruTagMatcher") {
  static readonly layer = Layer.effect(
    DanbooruTagMatcher,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findExactNameTag = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: TagNameRow,
        execute: (name) => sql`
          SELECT name FROM tags
          WHERE name = ${name} COLLATE NOCASE
          ORDER BY post_count DESC
          LIMIT 1
        `,
      });

      const findExactCnTag = SqlSchema.findOneOption({
        Request: Schema.Struct({
          cnName: Schema.String,
          isArtist: Schema.Boolean,
        }),
        Result: TagNameRow,
        execute: ({ cnName, isArtist }) => sql`
          SELECT name FROM tags
          WHERE cn_name = ${cnName}
            AND ${isArtist ? sql`category = 1` : sql`category != 1`}
          ORDER BY post_count DESC
          LIMIT 1
        `,
      });

      const findPrefixTag = SqlSchema.findOneOption({
        Request: Schema.Struct({
          pattern: Schema.String,
          isArtist: Schema.Boolean,
        }),
        Result: TagNameRow,
        execute: ({ pattern, isArtist }) => sql`
          SELECT name FROM tags
          WHERE (name LIKE ${pattern} OR cn_name LIKE ${pattern})
            AND ${isArtist ? sql`category = 1` : sql`category != 1`}
          ORDER BY post_count DESC
          LIMIT 1
        `,
      });

      const findFuzzyCandidates = SqlSchema.findAll({
        Request: Schema.Struct({
          normalized: Schema.String,
          part0: Schema.NullOr(Schema.String),
          part1: Schema.NullOr(Schema.String),
        }),
        Result: TagCandidateRow,
        execute: ({ normalized, part0, part1 }) => {
          const containsPattern = `%${normalized}%`;
          return part0 !== null && part1 !== null
            ? sql`
                SELECT name, post_count FROM tags
                WHERE (name LIKE ${`%${part0}%`} AND name LIKE ${`%${part1}%`})
                   OR name LIKE ${containsPattern}
                ORDER BY post_count DESC
                LIMIT 50
              `
            : sql`
                SELECT name, post_count FROM tags
                WHERE name LIKE ${containsPattern}
                ORDER BY post_count DESC
                LIMIT 50
              `;
        },
      });

      const findTagTranslations = SqlSchema.findAll({
        Request: Schema.Array(Schema.String),
        Result: TagTranslationRow,
        execute: (tags) => sql`
          SELECT name, cn_name, category FROM tags
          WHERE name IN ${sql.in(tags)}
        `,
      });

      const matchTag = Effect.fnUntraced(function* (word: string) {
        const normalized = word.trim().toLowerCase();
        if (!normalized) return undefined;

        // 1. Exact match on canonical English tag name
        const exactName = yield* findExactNameTag(normalized).pipe(
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(exactName)) {
          return exactName.value.name;
        }

        // 2-5. Exact Chinese name & prefix match: non-artist (category != 1) first, then artist (category = 1)
        const prefixPattern = `${normalized}%`;
        for (const isArtist of [false, true]) {
          const exactCn = yield* findExactCnTag({
            cnName: normalized,
            isArtist,
          }).pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(exactCn)) {
            return exactCn.value.name;
          }

          const prefixMatch = yield* findPrefixTag({
            pattern: prefixPattern,
            isArtist,
          }).pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(prefixMatch)) {
            return prefixMatch.value.name;
          }
        }

        // 6. Typo / compound / substring match for English words
        if (VALID_ENGLISH_WORD_REGEX.test(normalized)) {
          const parts = normalized.split("_").filter(Boolean);
          const candidateRows = yield* findFuzzyCandidates({
            normalized,
            part0: parts.length > 1 ? (parts[0] ?? null) : null,
            part1: parts.length > 1 ? (parts[1] ?? null) : null,
          }).pipe(Effect.orElseSucceed(() => []));

          return (
            pickBestFuzzyCandidate(normalized, candidateRows) ?? normalized
          );
        }

        return undefined;
      });

      const matchQuery = makeMatchQuery(matchTag);

      const getTagTranslations = Effect.fnUntraced(function* (
        tags: readonly string[],
      ) {
        const validTags = tags
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        const translationMap = new Map<string, string>();
        if (validTags.length === 0) {
          return translationMap as ReadonlyMap<string, string>;
        }

        const rows = yield* findTagTranslations(validTags).pipe(
          Effect.orElseSucceed(() => []),
        );

        for (const row of rows) {
          const rawCn = row.cn_name?.trim();
          if (rawCn) {
            translationMap.set(
              row.name,
              row.category === 1 ? cleanArtistName(rawCn) : rawCn,
            );
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
