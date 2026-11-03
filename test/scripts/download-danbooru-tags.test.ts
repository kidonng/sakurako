import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

describe("download-danbooru-tags indexing logic", () => {
  it("ensures indexes on tags table", () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE tags (name TEXT PRIMARY KEY, category INTEGER, cn_name TEXT, post_count INTEGER);",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);",
    );
    db.run("CREATE INDEX IF NOT EXISTS idx_tags_cn_name ON tags(cn_name);");
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);",
    );

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_tags_name");
    expect(names).toContain("idx_tags_cn_name");
    expect(names).toContain("idx_tags_post_count");
  });
});
