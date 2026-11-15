/* oxlint-disable effecttsgo/unstable-api-usage */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql";
import { DanbooruTagMatcher } from "../../../src/features/danbooru/DanbooruTagMatcher.ts";

const makeInMemoryTestLayer = () =>
  DanbooruTagMatcher.layer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  );

describe("DanbooruTagMatcher", () => {
  it("matches exact Chinese and English tags", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('cat_ears', '猫耳', 0, 50000);`;

      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("白发 cat_ears");
      expect(tags).toEqual(["white_hair", "cat_ears"]);
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("handles fuzzy prefix and typo matching with post_count ranking", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('white_hair_girl', '白发少女', 0, 10000);`;

      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("white_hai"); // missing last 'r'
      expect(tags).toEqual(["white_hair"]);
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("handles extra spaces properly without producing empty tags", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('white_hair', '白发', 0, 100000), ('cat_ears', '猫耳', 0, 50000);`;

      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("   白发    cat_ears   ");
      expect(tags).toEqual(["white_hair", "cat_ears"]);
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("falls back gracefully when tags table does not exist", async () => {
    const testProgram = Effect.gen(function* () {
      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("hatsune_miku");
      expect(tags).toEqual(["hatsune_miku"]);
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("matches reversed compound tags like miku_hatsune to hatsune_miku", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES ('hatsune_miku', '初音未来', 4, 150000);`;

      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("miku_hatsune");
      expect(tags).toEqual(["hatsune_miku"]);
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("builds live layer gracefully when database does not exist on disk", async () => {
    const testProgram = Effect.gen(function* () {
      const matcher = yield* DanbooruTagMatcher;
      const tags = yield* matcher.matchQuery("hatsune_miku 初音");
      expect(tags).toEqual(["hatsune_miku"]);
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

  it("batch translates tags to Chinese using getTagTranslations", async () => {
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

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("prioritizes non-artist tags over artist translations when matching queries", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES
        ('qilunuo', '琪露诺', 1, 10),
        ('cirno', '琪露诺（东方Project）', 4, 41488),
        ('dairi', 'dairi', 1, 18872),
        ('dairi-chan_(otokuyou)', '代理酱（Otokuyou）', 4, 18);`;

      const matcher = yield* DanbooruTagMatcher;
      const resCirno = yield* matcher.matchTag("琪露诺");
      expect(resCirno).toBe("cirno");

      const resDairi = yield* matcher.matchTag("dairi");
      expect(resDairi).toBe("dairi");
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });

  it("strips redundant artist category suffix in getTagTranslations", async () => {
    const testProgram = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE tags (name TEXT, cn_name TEXT, category INTEGER, post_count INTEGER);`;
      yield* sql`INSERT INTO tags VALUES
        ('tandohark', 'tandohark（画师）', 1, 1181),
        ('akari_ryuryuwa', 'Akari_Ryuryuwa (画师)', 1, 500);`;

      const matcher = yield* DanbooruTagMatcher;
      const translations = yield* matcher.getTagTranslations([
        "tandohark",
        "akari_ryuryuwa",
      ]);
      expect(translations.get("tandohark")).toBe("tandohark");
      expect(translations.get("akari_ryuryuwa")).toBe("Akari_Ryuryuwa");
    });

    await Effect.runPromise(
      testProgram.pipe(Effect.provide(makeInMemoryTestLayer())),
    );
  });
});
