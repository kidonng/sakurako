/* oxlint-disable effecttsgo/unstable-api-usage */
import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql";
import {
  DanbooruTagMatcher,
  lookupDanbooruTagTranslations,
} from "../../../src/features/danbooru/DanbooruTagMatcher.ts";

describe("DanbooruTagMatcher", () => {
  it("matches exact Chinese and English tags", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('cat_ears', '猫耳', 0, 50000);`;

      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("白发 cat_ears");
      expect(res.tags).toEqual(["white_hair", "cat_ears"]);
      expect(res.isModified).toBe(true); // "白发" was converted to "white_hair"
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(true),
    } as unknown as FileSystem);

    const TestLive = Layer.merge(
      DanbooruTagMatcher.layer.pipe(
        Layer.provide(MockFs),
        Layer.provide(SqlLive),
      ),
      SqlLive,
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });

  it("handles fuzzy prefix and typo matching with post_count ranking", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('white_hair_girl', '白发少女', 0, 10000);`;

      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("white_hai"); // missing last 'r'
      expect(res.tags).toEqual(["white_hair"]);
      expect(res.isModified).toBe(true);
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(true),
    } as unknown as FileSystem);

    const TestLive = Layer.merge(
      DanbooruTagMatcher.layer.pipe(
        Layer.provide(MockFs),
        Layer.provide(SqlLive),
      ),
      SqlLive,
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });

  it("handles extra spaces properly without producing empty tags", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('cat_ears', '猫耳', 0, 50000);`;

      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("   白发    cat_ears   ");
      expect(res.tags).toEqual(["white_hair", "cat_ears"]);
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(true),
    } as unknown as FileSystem);

    const TestLive = Layer.merge(
      DanbooruTagMatcher.layer.pipe(
        Layer.provide(MockFs),
        Layer.provide(SqlLive),
      ),
      SqlLive,
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });

  it("falls back gracefully when database does not exist", async () => {
    const testProgram = Effect.gen(function* () {
      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("hatsune_miku");
      expect(res.tags).toEqual(["hatsune_miku"]);
      expect(res.isModified).toBe(false);
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(false),
    } as unknown as FileSystem);

    const TestLive = DanbooruTagMatcher.layer.pipe(
      Layer.provide(SqlLive),
      Layer.provide(MockFs),
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });

  it("matches reversed compound tags like miku_hatsune to hatsune_miku", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('hatsune_miku', '初音未来', 4, 150000);`;

      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("miku_hatsune");
      expect(res.tags).toEqual(["hatsune_miku"]);
      expect(res.isModified).toBe(true);
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(true),
    } as unknown as FileSystem);

    const TestLive = Layer.merge(
      DanbooruTagMatcher.layer.pipe(
        Layer.provide(MockFs),
        Layer.provide(SqlLive),
      ),
      SqlLive,
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });

  it("builds live layer gracefully when database does not exist on disk", async () => {
    const testProgram = Effect.gen(function* () {
      const matcher = yield* DanbooruTagMatcher;
      const res = yield* matcher.matchQuery("hatsune_miku");
      expect(res.tags).toEqual(["hatsune_miku"]);
      expect(res.isModified).toBe(false);
    });

    const TestLive = DanbooruTagMatcher.live({
      filename: "assets/non-existent-tags.sqlite",
    });

    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(false),
    } as unknown as FileSystem);

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(TestLive.pipe(Layer.provide(MockFs)))),
    );
  });

  it("batch translates tags to Chinese using getTagTranslations and lookupDanbooruTagTranslations", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('cat_ears', '猫耳', 0, 50000);`;

      const matcher = yield* DanbooruTagMatcher;
      const translations = yield* matcher.getTagTranslations([
        "white_hair",
        "cat_ears",
        "unknown_tag_xyz",
      ]);
      expect(translations.get("white_hair")).toBe("白发");
      expect(translations.get("cat_ears")).toBe("猫耳");
      expect(translations.has("unknown_tag_xyz")).toBe(false);
    });

    const SqlLive = SqliteClient.layer({ filename: ":memory:" });
    const MockFs = Layer.succeed(FileSystem, {
      exists: () => Effect.succeed(true),
    } as unknown as FileSystem);

    const TestLive = Layer.merge(
      DanbooruTagMatcher.layer.pipe(
        Layer.provide(MockFs),
        Layer.provide(SqlLive),
      ),
      SqlLive,
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));

    const memDb = new Database(":memory:");
    memDb.run("CREATE TABLE tags (name TEXT, cn_name TEXT);");
    memDb.run(
      "INSERT INTO tags VALUES ('white_hair', '白发'), ('cat_ears', '猫耳');",
    );

    try {
      const syncMap = lookupDanbooruTagTranslations(
        ["white_hair", "cat_ears"],
        memDb,
      );
      expect(syncMap.get("white_hair")).toBe("白发");
      expect(syncMap.get("cat_ears")).toBe("猫耳");
    } finally {
      memDb.close();
    }
  });
  it("gracefully falls back when database file does not exist", () => {
    const syncMap = lookupDanbooruTagTranslations(
      ["white_hair"],
      "assets/non-existent.sqlite",
    );
    expect(syncMap.size).toBe(0);
  });
});
