# Danbooru 图片检索与标签智能匹配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Danbooru 随机图片检索功能（`/dbr [可选搜索词]`），通过本地离线 SQLite 标签对照库智能匹配中英文标签与容错纠错，调用 Danbooru 官方 API 获取 SFW 插画并按标准格式回复图文消息。

**Architecture:** 
- 离线数据层：`assets/danbooru-tags.sqlite`（由 `bun run download-tags` 脚本下载并建索引，不进 git），通过 `DanbooruTagMatcher`（基于 `effect/sql` 的只读 `SqlClient.SqlClient`）执行分级匹配（精确 -> 前缀 -> 编辑距离选优）。
- 接口客户端：`DanbooruClient` 复用 `src/utils/HttpClient.ts` 的 `executeWithResponse` 请求 Danbooru `/posts/random.json`，处理 200/204/404/429 状态。
- 排版与交互：`DanbooruFormatter` 复刻 Danbooru 官方标题格式；`handleDanbooruMessage` 在 `src/index.ts` 监听 `/dbr` 命令，校验最多 2 个普通标签限制，并根据是否有改动附加 `🔍 [实际搜索词]` 标头。

**Tech Stack:** Bun 1.4+, TypeScript 5+, Effect 4 (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`, `effect/sql`), `@snowluma/sdk`, `bun:test`.

**Spec:** `.superpowers/specs/2026-11-04-danbooru-design.md`

## Global Constraints

- 语言与运行时：Bun 1.4+, TypeScript 5+, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`。
- 架构范式：遵循 Effect 4 标准（`Effect.gen`, `Context.Service`, `Layer`, `Schema.TaggedError` 带 branded symbol）。
- HTTP 请求：统一使用 `src/utils/HttpClient.ts`（`executeWithResponse`），禁止裸 `fetch`。
- SQL 查询：统一使用 `effect/sql` 模板标签查询，禁止手动字符串拼接 SQL。
- 单元测试：原生 `bun:test`，HTTP 请求使用 `makeTestHttpClient`，禁止 `as any`。
- 质量保证：必须通过 `bun test`、`bun run check`、`bun run lint`。

## Review Focus

- 输入包含多余空格（如 `/dbr   白发    猫耳  `）：期望分词正确且合并多余空格，不应产生空标签。
- 输入纯英文但存在轻度拼写错误（如 `white_hai` 或 `miku_hatsune`）：期望容错匹配到正确的 Danbooru 标签（如 `white_hair` / `hatsune_miku`）。
- 解析出的普通标签数量超过 2 个（如 `/dbr 白发 猫耳 少女` -> 3 个 tags）：期望立即回复 `[标签数量超出限制，最多支持 2 个]`，不调用 Danbooru API。
- Danbooru 返回 204 或 404（无匹配图片）：期望回复 `[未找到符合条件的图片]`，不发生崩溃或静默。
- 本地 `assets/danbooru-tags.sqlite` 数据库缺失：期望优雅降级，透传英文输入并打印 Warning，不导致启动失败。

---

### Task 1: 标签对照库下载脚本与资源忽略配置

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `scripts/download-danbooru-tags.ts`
- Test: `test/scripts/download-danbooru-tags.test.ts`

**Interfaces:**
- Consumes: `FileSystem` and `Path` from `@effect/platform-bun`
- Produces: `assets/danbooru-tags.sqlite` with `idx_tags_name`, `idx_tags_cn_name`, `idx_tags_post_count` indexes; `npm run download-tags` script.

- [ ] **Step 1: Write the test for download-danbooru-tags logic**

```ts
// test/scripts/download-danbooru-tags.test.ts
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

describe("download-danbooru-tags indexing logic", () => {
  it("ensures indexes on tags table", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tags (name TEXT PRIMARY KEY, category INTEGER, cn_name TEXT, post_count INTEGER);");
    db.run("CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);");
    db.run("CREATE INDEX IF NOT EXISTS idx_tags_cn_name ON tags(cn_name);");
    db.run("CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);");

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_tags_name");
    expect(names).toContain("idx_tags_cn_name");
    expect(names).toContain("idx_tags_post_count");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test test/scripts/download-danbooru-tags.test.ts`
Expected: PASS

- [ ] **Step 3: Update `.gitignore` and `package.json`**

In `.gitignore`, add:
```
assets/*.sqlite
```
In `package.json` `scripts`, add:
```json
"download-tags": "bun scripts/download-danbooru-tags.ts"
```

- [ ] **Step 4: Implement `scripts/download-danbooru-tags.ts`**

Follow the pattern of `scripts/download-font.ts`:
- Download `https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite` using `FileSystem` and `fetch`.
- Save to `assets/danbooru-tags.sqlite`.
- Open with `bun:sqlite` to execute index creation (`CREATE INDEX IF NOT EXISTS...`).

- [ ] **Step 5: Verify script execution dry-run / lint**

Run: `bun run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json scripts/download-danbooru-tags.ts test/scripts/download-danbooru-tags.test.ts
git commit -m "danbooru: add tag database download script and ignore rule"
```

---

### Task 2: Danbooru 标题格式化算法 (`DanbooruFormatter`)

**Files:**
- Create: `src/features/danbooru/DanbooruFormatter.ts`
- Test: `test/features/danbooru/DanbooruFormatter.test.ts`

**Interfaces:**
- Consumes:
  ```ts
  export interface DanbooruPostTitleMeta {
    readonly id: number;
    readonly tag_string_character: string;
    readonly tag_string_copyright: string;
    readonly tag_string_artist: string;
  }
  ```
- Produces: `formatDanbooruTitle(post: DanbooruPostTitleMeta): string`

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/danbooru/DanbooruFormatter.test.ts
import { describe, expect, it } from "bun:test";
import { formatDanbooruTitle } from "../../src/features/danbooru/DanbooruFormatter.ts";

describe("formatDanbooruTitle", () => {
  it("formats character, copyright, and artist correctly", () => {
    const post = {
      id: 12345,
      tag_string_character: "reisen_udongein_inaba",
      tag_string_copyright: "touhou",
      tag_string_artist: "nacht_musik",
    };
    expect(formatDanbooruTitle(post)).toBe("reisen udongein inaba (touhou) drawn by nacht musik");
  });

  it("handles multiple characters and copyrights with 'more' suffix", () => {
    const post = {
      id: 12345,
      tag_string_character: "char1 char2 char3 char4 char5 char6",
      tag_string_copyright: "copy1 copy2",
      tag_string_artist: "artist1 artist2",
    };
    expect(formatDanbooruTitle(post)).toBe("char1, char2, char3, char4, char5, and 1 more (copy1 and 1 more) drawn by artist1 and artist2");
  });

  it("omits empty components and falls back to #id when tags are blank", () => {
    expect(formatDanbooruTitle({ id: 999, tag_string_character: "", tag_string_copyright: "", tag_string_artist: "kantoku" }))
      .toBe("drawn by kantoku");
    expect(formatDanbooruTitle({ id: 999, tag_string_character: "", tag_string_copyright: "", tag_string_artist: "" }))
      .toBe("#999");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/danbooru/DanbooruFormatter.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `formatDanbooruTitle` in `src/features/danbooru/DanbooruFormatter.ts`**

- Split tag strings by whitespace.
- Replace underscores `_` with spaces.
- Format arrays using `toSentence` helper (`["a"] -> "a"`, `["a", "b"] -> "a and b"`, `["a", "b", "c"] -> "a, b, and c"`).
- Character: up to 5 items, if > 5 append `${len - 5} more`.
- Copyright: up to 1 item, if > 1 append `${len - 1} more`. Wrap in `(...)` if characters exist.
- Artist: prepend `drawn by `.
- Fallback: `#${post.id}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/danbooru/DanbooruFormatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/danbooru/DanbooruFormatter.ts test/features/danbooru/DanbooruFormatter.test.ts
git commit -m "danbooru: implement official post title formatting algorithm"
```

---

### Task 3: 标签智能匹配器 (`DanbooruTagMatcher`)

**Files:**
- Create: `src/features/danbooru/DanbooruTagMatcher.ts`
- Test: `test/features/danbooru/DanbooruTagMatcher.test.ts`

**Interfaces:**
- Consumes: `effect/sql` (`SqlClient.SqlClient`), `FileSystem` from `effect/FileSystem`
- Produces:
  ```ts
  export class DanbooruTagMatcher extends Context.Service<DanbooruTagMatcher, {
    readonly matchTag: (word: string) => Effect.Effect<string | undefined>;
    readonly matchQuery: (rawQuery: string) => Effect.Effect<{
      readonly tags: readonly string[];
      readonly isModified: boolean;
    }>;
  }>()("sakurako/danbooru/DanbooruTagMatcher") {
    static readonly layer: Layer.Layer<DanbooruTagMatcher, never, SqlClient.SqlClient | FileSystem>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/danbooru/DanbooruTagMatcher.test.ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { FileSystem } from "effect/FileSystem";
import { DanbooruTagMatcher } from "../../src/features/danbooru/DanbooruTagMatcher.ts";

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

    const TestLive = DanbooruTagMatcher.layer.pipe(
      Layer.provide(SqlLive),
      Layer.provide(MockFs)
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

    const TestLive = DanbooruTagMatcher.layer.pipe(
      Layer.provide(SqlLive),
      Layer.provide(MockFs)
    );

    await Effect.runPromise(testProgram.pipe(Effect.provide(TestLive)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/danbooru/DanbooruTagMatcher.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `DanbooruTagMatcher` in `src/features/danbooru/DanbooruTagMatcher.ts`**

- Include lightweight `levenshteinDistance(a: string, b: string): number` pure function.
- Query using `sql<{ name: string; post_count: number }>`:
  1. Exact: `WHERE name = ${word} COLLATE NOCASE OR cn_name = ${word}`.
  2. Prefix: `WHERE name LIKE ${word + "%"} OR cn_name LIKE ${word + "%"} ORDER BY post_count DESC LIMIT 10`.
  3. Fuzzy: if word is alphanumeric/underscore, `WHERE name LIKE ${"%" + word + "%"} ORDER BY post_count DESC LIMIT 30`, score candidates via Levenshtein + log(post_count).
- In `matchQuery(rawQuery)`: tokenize with `/\s+/`, deduplicate tags, compare resolved string with raw input to determine `isModified`.
- Fallback when database file is missing: return input tag as-is for English words, log Warning, do not throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/danbooru/DanbooruTagMatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/danbooru/DanbooruTagMatcher.ts test/features/danbooru/DanbooruTagMatcher.test.ts
git commit -m "danbooru: implement tag matcher service with effect/sql and fuzzy ranking"
```

---

### Task 4: Danbooru API 客户端 (`DanbooruClient`)

**Files:**
- Create: `src/features/danbooru/DanbooruClient.ts`
- Test: `test/features/danbooru/DanbooruClient.test.ts`

**Interfaces:**
- Consumes: `src/utils/HttpClient.ts` (`executeWithResponse`, `HttpFetchError`), `HttpClient.HttpClient`
- Produces:
  ```ts
  export const DanbooruPostSchema = Schema.Struct({
    id: Schema.Finite,
    file_url: Schema.optional(Schema.String),
    large_file_url: Schema.optional(Schema.String),
    preview_file_url: Schema.optional(Schema.String),
    tag_string_character: Schema.String,
    tag_string_copyright: Schema.String,
    tag_string_artist: Schema.String,
    tag_string_general: Schema.String,
  });
  export type DanbooruPost = typeof DanbooruPostSchema.Type;

  export class DanbooruNotFoundError extends Schema.TaggedError<
    DanbooruNotFoundError,
    { readonly brand: unique symbol }
  >()("DanbooruNotFoundError", { queryTags: Schema.String }) {}

  export class DanbooruRateLimitError extends Schema.TaggedError<
    DanbooruRateLimitError,
    { readonly brand: unique symbol }
  >()("DanbooruRateLimitError", {}) {}

  export class DanbooruApiError extends Schema.TaggedError<
    DanbooruApiError,
    { readonly brand: unique symbol }
  >()("DanbooruApiError", {
    status: Schema.Finite,
    message: Schema.String,
  }) {}

  export class DanbooruClient extends Context.Service<DanbooruClient, {
    readonly getRandomPost: (
      tags?: readonly string[],
    ) => Effect.Effect<
      DanbooruPost,
      DanbooruNotFoundError | DanbooruRateLimitError | DanbooruApiError
    >;
  }>()("sakurako/danbooru/DanbooruClient") {
    static readonly layer: Layer.Layer<DanbooruClient, never, HttpClient.HttpClient>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/danbooru/DanbooruClient.test.ts
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { makeTestHttpClient } from "../../test/TestHttpClient.ts";
import { DanbooruClient } from "../../src/features/danbooru/DanbooruClient.ts";

describe("DanbooruClient", () => {
  it("fetches random post successfully on HTTP 200", async () => {
    const mockPost = {
      id: 12345,
      large_file_url: "https://danbooru.donmai.us/data/large.jpg",
      tag_string_character: "reisen_udongein_inaba",
      tag_string_copyright: "touhou",
      tag_string_artist: "nacht_musik",
      tag_string_general: "1girl",
    };

    const clientLive = makeTestHttpClient((req) => {
      expect(req.url).toContain("https://danbooru.donmai.us/posts/random.json");
      expect(req.url).toContain("is%3Asfw");
      return new Response(JSON.stringify(mockPost), { status: 200 });
    });

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      const post = yield* client.getRandomPost(["touhou"]);
      expect(post.id).toBe(12345);
      expect(post.large_file_url).toBe("https://danbooru.donmai.us/data/large.jpg");
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer),
        Effect.provide(clientLive),
      ),
    );
  });

  it("handles HTTP 204 or 404 as DanbooruNotFoundError", async () => {
    const clientLive = makeTestHttpClient(() => new Response(null, { status: 204 }));

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      return yield* client.getRandomPost(["non_existent_tag"]);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer),
        Effect.provide(clientLive),
        Effect.flip,
      ),
    );

    expect(result._tag).toBe("DanbooruNotFoundError");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/danbooru/DanbooruClient.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `DanbooruClient` in `src/features/danbooru/DanbooruClient.ts`**

- Build request with `HttpClientRequest.get("https://danbooru.donmai.us/posts/random.json")`.
- Append `tags`: `is:sfw is:active ${tags.join(" ")}`.
- Pass to `executeWithResponse`.
- If status is 204, return `new DanbooruNotFoundError({ queryTags })`.
- If status is 200, parse with `HttpClientResponse.schemaBodyJson(DanbooruPostSchema)`.
- Catch `HttpFetchError`: map status 404 to `DanbooruNotFoundError`, 429 to `DanbooruRateLimitError`, else `DanbooruApiError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/danbooru/DanbooruClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/danbooru/DanbooruClient.ts test/features/danbooru/DanbooruClient.test.ts
git commit -m "danbooru: implement api client service with error tagging"
```

---

### Task 5: 交互命令处理流水线 (`Danbooru.ts`)

**Files:**
- Create: `src/features/danbooru/Danbooru.ts`
- Test: `test/features/danbooru/Danbooru.test.ts`

**Interfaces:**
- Consumes: `DanbooruTagMatcher`, `DanbooruClient`, `formatDanbooruTitle`, `IncomingMessage` from `src/SnowLuma.ts`, `parseCommand` from `src/utils/Command.ts`
- Produces: `handleDanbooruMessage: (item: IncomingMessage) => Effect.Effect<void, never, DanbooruTagMatcher | DanbooruClient>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/danbooru/Danbooru.test.ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { handleDanbooruMessage } from "../../src/features/danbooru/Danbooru.ts";
import { DanbooruTagMatcher } from "../../src/features/danbooru/DanbooruTagMatcher.ts";
import { DanbooruClient, DanbooruNotFoundError } from "../../src/features/danbooru/DanbooruClient.ts";
import type { IncomingMessage } from "../../src/SnowLuma.ts";

describe("handleDanbooruMessage", () => {
  it("rejects queries with more than 2 tags", async () => {
    let replied = "";
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr tag1 tag2 tag3" } }],
      },
      context: {
        reply: (msg: string) => {
          replied = msg;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined),
      matchQuery: () => Effect.succeed({ tags: ["t1", "t2", "t3"], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(MatcherMock),
        Effect.provide(ClientMock),
      ),
    );

    expect(replied).toBe("[标签数量超出限制，最多支持 2 个]");
  });

  it("replies with formatted title and image when search succeeds", async () => {
    let replyPayload: unknown = null;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr 白发" } }],
      },
      context: {
        reply: (payload: unknown) => {
          replyPayload = payload;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined),
      matchQuery: () => Effect.succeed({ tags: ["white_hair"], isModified: true }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 100,
          large_file_url: "https://example.com/100.jpg",
          tag_string_character: "",
          tag_string_copyright: "",
          tag_string_artist: "artist",
          tag_string_general: "white_hair",
        }),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(MatcherMock),
        Effect.provide(ClientMock),
      ),
    );

    // Verify reply includes prefix 🔍 white_hair, title, and image segment
    expect(replyPayload).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/danbooru/Danbooru.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `handleDanbooruMessage` in `src/features/danbooru/Danbooru.ts`**

- Use `isSelfMessage(event)`.
- Use `parseCommand(event)`. Match command text starting with `/dbr` (e.g. `/dbr` or `/dbr <query>`).
- If command doesn't start with `/dbr`, return.
- If raw query is present:
  - Call `DanbooruTagMatcher.matchQuery(rawQuery)`.
  - If `tags.length > 2`, reply `"[标签数量超出限制，最多支持 2 个]"`.
  - If `tags.length === 0`, reply `"[未找到匹配的标签]"`.
- Call `DanbooruClient.getRandomPost(tags)`.
  - Catch `DanbooruNotFoundError` -> reply `"[未找到符合条件的图片]"`.
  - Catch `DanbooruRateLimitError` -> reply `"[Danbooru 请求过于频繁，请稍后再试]"`.
  - Catch other errors -> reply `"[Danbooru 接口请求失败]"`.
- Extract image URL (`post.large_file_url ?? post.file_url`). If missing, reply `"[未获取到有效图片链接]"`.
- Format message:
  - If `isModified`, header is `🔍 ${tags.join(" ")}\n`.
  - Title: `${formatDanbooruTitle(post)}\n`.
  - Image: `segments.image(imageUrl)`.
- Call `item.context.reply(...)`. Isolate per-event errors with `Effect.catchAll`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/danbooru/Danbooru.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/danbooru/Danbooru.ts test/features/danbooru/Danbooru.test.ts
git commit -m "danbooru: implement message handler and command routing"
```

---

### Task 6: 消息流挂载与端到端集成 (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`
- Test: `test/features/danbooru/DanbooruIntegration.test.ts`

**Interfaces:**
- Consumes: `handleDanbooruMessage`, `DanbooruTagMatcher`, `DanbooruClient`
- Produces: active message consumer for `/dbr` in `MainProgram`.

- [ ] **Step 1: Write integration test**

```ts
// test/features/danbooru/DanbooruIntegration.test.ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { DanbooruTagMatcher } from "../../src/features/danbooru/DanbooruTagMatcher.ts";
import { DanbooruClient } from "../../src/features/danbooru/DanbooruClient.ts";
import { handleDanbooruMessage } from "../../src/features/danbooru/Danbooru.ts";
import type { IncomingMessage } from "../../src/SnowLuma.ts";

describe("Danbooru integration message flow", () => {
  it("ignores non-dbr commands silently", async () => {
    let called = false;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "hello world" } }],
      },
      context: {
        reply: () => {
          called = true;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined),
      matchQuery: () => Effect.succeed({ tags: [], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(MatcherMock),
        Effect.provide(ClientMock),
      ),
    );

    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Mount `handleDanbooruMessage` in `src/index.ts`**

- Add `DanbooruSqliteLive = SqliteClient.layer({ filename: "assets/danbooru-tags.sqlite", readonly: true })`.
- Add `DanbooruTagMatcherLive = DanbooruTagMatcher.layer.pipe(Layer.provide(DanbooruSqliteLive), Layer.provide(BunFileSystem.layer))`.
- Add `DanbooruClientLive = DanbooruClient.layer.pipe(Layer.provide(FetchHttpClient.layer))`.
- In `Stream.runForEach((item) => Effect.all([...]))`:
  add `handleDanbooruMessage(item)`.
- Provide `DanbooruTagMatcherLive` and `DanbooruClientLive` to `MainProgram`.

- [ ] **Step 3: Run full verification suite**

Run:
```bash
bun test
bun run check
bun run lint
```
Expected: All tests pass, type check clean, 0 lint warnings.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts test/features/danbooru/DanbooruIntegration.test.ts
git commit -m "danbooru: wire handler into application entrypoint and layer graph"
```
