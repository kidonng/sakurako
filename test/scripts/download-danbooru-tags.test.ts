/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

describe("download-danbooru-tags indexing logic", () => {
  it("ensures indexes on tags table", async () => {
    const prog = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT PRIMARY KEY, category INTEGER, cn_name TEXT, post_count INTEGER);`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tags_cn_name ON tags(cn_name);`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);`;

      const rows = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='index'`;
      const names = rows.map((i) => i.name);
      expect(names).toContain("idx_tags_name");
      expect(names).toContain("idx_tags_cn_name");
      expect(names).toContain("idx_tags_post_count");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));

    await Effect.runPromise(prog);
  });
});
