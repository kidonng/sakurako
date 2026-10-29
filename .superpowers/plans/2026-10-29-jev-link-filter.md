# Jev 决策模型链接预览筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 OpenRouter 托管的 TypeSafe Jev 决策模型与 Noul 概率原语，为链接预览提供实质信息增益过滤，单链接未通过时静默，多链接部分未通过时保留 `[序号]. （已过滤）` 占位符。

**Architecture:** 在元数据抓取后与格式化渲染前增加决策过滤层。基于 Effect 4 原生 `HttpClient.HttpClient` 调用 OpenRouter System One API（`https://openrouter.ai/api/v1/systemone`），在单次请求中并发评估所有候选预览的 Noul 概率；`formatPreview` 增强对 `Filtered` 结果的占位展示与静默决策。

**Tech Stack:** TypeScript, Bun, Effect 4 (`effect`, `effect/http`), OpenRouter System One API (`~typesafe/jev-latest`).

**Spec:** `.superpowers/specs/2026-10-29-jev-link-filter-design.md`

## Global Constraints

- 遵循项目既有的代码规范与 Effect 4 实践（`Context.Service`、`Data.TaggedError`、`HttpClient`）。
- 严格遵循 `verbatimModuleSyntax: true`，禁止使用 `any` 或 `as any`。
- 本地模块导入必须包含 `.ts` 扩展名（如 `import { BotConfig } from "../../Config.ts"`）。
- HTTP 请求测试严禁 mock 全局 `fetch`，必须使用 `test/TestHttpClient.ts` 中的 `makeTestHttpClient`。
- 提交信息遵循 Linux Kernel 规范（包含 scope, Problem, Solution, References）。

## Review Focus

1. **OpenRouter 响应字段缺失或非预期**：响应体缺少某 question 字段或 `noul` 非数字时，安全回退而不抛出未捕获异常。
2. **API 限流 (429) 或网络超时**：必须稳健降级（fail-open），退回到原始未过滤结果，保证基础消息流正常运行。
3. **抓取结果全为失败项**：当所有 URL 在前置抓取中均失败时，跳过 Jev 请求直接返回，避免无效网络开销。
4. **单链接被过滤或多链接全部被过滤**：`formatPreview` 必须返回 `null`，确保 Bot 保持静默不发空回复。
5. **配图防污染**：首张配图只能提取自 `Success` 且未被过滤的条目，被过滤链接的配图不得泄露到最终消息。

---

### Task 1: BotConfig 支持 `OPENROUTER_API_KEY`

**Files:**
- Modify: `src/Config.ts`
- Test: `test/Config.test.ts`

**Interfaces:**
- Produces: `BotConfig.openrouterApiKey?: Redacted.Redacted<string>`

- [ ] **Step 1: Write the failing tests in `test/Config.test.ts`**

Add tests to verify reading `OPENROUTER_API_KEY` into `openrouterApiKey` as `Redacted.Redacted<string>`, and defaulting to `undefined` when omitted.

```ts
it("reads optional OPENROUTER_API_KEY when provided", async () => {
  const config = await Effect.runPromise(
    BotConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            SNOWLUMA_WS_URL: "ws://localhost:3001",
            SNOWLUMA_ACCESS_TOKEN: "token",
            OPENROUTER_API_KEY: "test_openrouter_key",
          }),
        ),
      ),
    ),
  );
  expect(config.openrouterApiKey).toBeDefined();
  expect(Redacted.value(config.openrouterApiKey!)).toBe("test_openrouter_key");
});

it("defaults openrouterApiKey to undefined when omitted", async () => {
  const config = await Effect.runPromise(
    BotConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            SNOWLUMA_WS_URL: "ws://localhost:3001",
            SNOWLUMA_ACCESS_TOKEN: "token",
          }),
        ),
      ),
    ),
  );
  expect(config.openrouterApiKey).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/Config.test.ts`
Expected: FAIL with property `openrouterApiKey` does not exist on `BotConfig`.

- [ ] **Step 3: Update `src/Config.ts`**

Add `openrouterApiKey?: Redacted.Redacted<string>` to `interface BotConfig`, and add `openrouterApiKey` loader using `Config.option(Config.Redacted("OPENROUTER_API_KEY"))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/Config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/Config.ts test/Config.test.ts
git commit -m "config: add optional OPENROUTER_API_KEY support"
```

---

### Task 2: `formatPreview` 支持 `Filtered` 状态与占位展示

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts:111-260`
- Test: `test/features/link-preview/LinkPreviewFormat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScrapingResult =
    | { readonly _tag: "Success"; readonly data: PageMetadata }
    | { readonly _tag: "Filtered"; readonly url: string }
    | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError };
  ```
- Consumes: `formatPreview(results: ReadonlyArray<ScrapingResult>): FormattedPreview | null`

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/LinkPreviewFormat.test.ts`**

Test scenarios:
1. Single link with `_tag: "Filtered"` returns `null`.
2. Multi-link with all `Filtered` returns `null`.
3. Multi-link with mixed `Filtered` and `Failure` (no `Success`) returns `null`.
4. Multi-link with partial `Filtered` and `Success` outputs `${num}. （已过滤）` for filtered items and normal text for success items.
5. First image is only selected from `Success` items, never from `Filtered` items.

```ts
it("returns null when single link is filtered", () => {
  const results: ScrapingResult[] = [
    { _tag: "Filtered", url: "https://example.com" },
  ];
  expect(formatPreview(results)).toBeNull();
});

it("returns null when all multiple links are filtered or failed", () => {
  const results: ScrapingResult[] = [
    { _tag: "Filtered", url: "https://example1.com" },
    {
      _tag: "Failure",
      url: "https://example2.com",
      error: new HttpFetchError({ url: "https://example2.com", detail: "Timeout" }),
    },
  ];
  expect(formatPreview(results)).toBeNull();
});

it("formats multiple links with partial filtered placeholders and preserves valid image", () => {
  const results: ScrapingResult[] = [
    {
      _tag: "Filtered",
      url: "https://filtered-news.com",
    },
    {
      _tag: "Success",
      data: {
        url: "https://useful-blog.com",
        title: "Useful Title",
        description: "Useful Desc",
        image: "https://useful-blog.com/cover.png",
      },
    },
  ];
  const formatted = formatPreview(results);
  expect(formatted).toEqual({
    text: "1. （已过滤）\n2. Useful Title\n> Useful Desc",
    image: "https://useful-blog.com/cover.png",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewFormat.test.ts`
Expected: FAIL because `Filtered` is not a valid `_tag` in `ScrapingResult`.

- [ ] **Step 3: Update `ScrapingResult` and `formatPreview` in `src/features/link-preview/LinkPreview.ts`**

1. Extend `ScrapingResult` union:
   ```ts
   export type ScrapingResult =
     | { readonly _tag: "Success"; readonly data: PageMetadata }
     | { readonly _tag: "Filtered"; readonly url: string }
     | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError };
   ```
2. In `formatPreview`:
   - If `!results.some((r) => r._tag === "Success")`, return `null`.
   - Single item mode: if `results.length === 1 && firstResult._tag === "Success"`, format single item (already returns `null` for non-Success).
   - Multi-item mode:
     - For `_tag === "Filtered"`: push `${num}. （已过滤）`.
     - For `_tag === "Failure"`: push `${num}. [提取失败：${item.error.message}]`.
     - For `_tag === "Success"`: format title/description, and select `firstImage` only when not set and not SVG.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewFormat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewFormat.test.ts
git commit -m "link-preview: support filtered item placeholders in formatPreview"
```

---

### Task 3: Jev 决策过滤核心实现 (`JevFilter.ts`)

**Files:**
- Create: `src/features/link-preview/JevFilter.ts`
- Test: `test/features/link-preview/JevFilter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class JevFilterError extends Data.TaggedError("JevFilterError")<{
    readonly cause: unknown;
  }> {}

  export function filterPreviewResults(
    rawMessage: string,
    results: ReadonlyArray<ScrapingResult>,
    apiKey?: Redacted.Redacted<string>,
    threshold?: number, // default 0.7
  ): Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/JevFilter.test.ts`**

Test scenarios:
1. Returns original results unchanged when `apiKey` is undefined.
2. Returns original results unchanged when no successful scrape results exist (all failures).
3. Sends POST request to OpenRouter `https://openrouter.ai/api/v1/systemone` with model `~typesafe/jev-latest`, bearer auth, state `{ user_message, previews }`, and Noul questions per preview.
4. Correctly converts successful items with Noul score `< 0.7` to `{ _tag: "Filtered", url }`, while keeping items with `>= 0.7` as `{ _tag: "Success", data }`.
5. Gracefully falls back (fail-open) and logs warning when OpenRouter returns 500 / 429 / network error.
6. Handles missing question key in response by filtering that item or falling back safely.

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Redacted } from "effect";
import { filterPreviewResults } from "../../../src/features/link-preview/JevFilter.ts";
import type { ScrapingResult } from "../../../src/features/link-preview/LinkPreview.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

describe("filterPreviewResults", () => {
  it("skips filtering when apiKey is not provided", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test Title" },
      },
    ];
    const dummyLayer = makeTestHttpClient(() => new Response("", { status: 500 }));
    const filtered = await Effect.runPromise(
      filterPreviewResults("some message", results, undefined).pipe(
        Effect.provide(dummyLayer),
      ),
    );
    expect(filtered).toEqual(results);
  });

  it("filters items below threshold 0.7 using OpenRouter System One", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://news.com", title: "News Article" },
      },
      {
        _tag: "Success",
        data: { url: "https://t.me/promo", title: "Promo Group" },
      },
    ];

    let requestBody: unknown = null;
    let authHeader: string | null = null;

    const layer = makeTestHttpClient(async (req) => {
      authHeader = req.headers.get("authorization");
      requestBody = await req.json();
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.14",
          answers: {
            preview_0: { type: "noul", noul: 0.95 },
            preview_1: { type: "noul", noul: 0.12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "message with news and promo",
        results,
        Redacted.make("sk-or-test"),
      ).pipe(Effect.provide(layer)),
    );

    expect(authHeader).toBe("Bearer sk-or-test");
    expect(filtered[0]._tag).toBe("Success");
    expect(filtered[1]._tag).toBe("Filtered");
  });

  it("falls back to original results when OpenRouter API fails", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test Title" },
      },
    ];
    const failLayer = makeTestHttpClient(
      () => new Response("Internal Server Error", { status: 500 }),
    );

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "test message",
        results,
        Redacted.make("sk-or-test"),
      ).pipe(Effect.provide(failLayer)),
    );

    expect(filtered).toEqual(results);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/JevFilter.test.ts`
Expected: FAIL because `JevFilter.ts` does not exist yet.

- [ ] **Step 3: Implement `src/features/link-preview/JevFilter.ts`**

1. Define System One payload interfaces:
   ```ts
   export interface SystemOneNoulQuestion {
     readonly type: "noul";
     readonly instructions: string;
     readonly criteria: {
       readonly true: string;
       readonly false: string;
     };
   }

   export interface SystemOneRequest {
     readonly model: string;
     readonly state: {
       readonly user_message: string;
       readonly previews: Record<string, {
         readonly url: string;
         readonly title?: string;
         readonly description?: string;
       }>;
     };
     readonly questions: Record<string, SystemOneNoulQuestion>;
   }

   export interface SystemOneResponse {
     readonly answers?: Record<string, {
       readonly type: string;
       readonly noul?: number;
     }>;
   }
   ```
2. Implement `filterPreviewResults`:
   - If `!apiKey` or no `Success` items, return `Effect.succeed(results)`.
   - Build `previews` object and `questions` object mapping index `preview_${index}`.
   - Construct HTTP POST to `https://openrouter.ai/api/v1/systemone` with `Bearer ${Redacted.value(apiKey)}`.
   - Wrap in `Effect.timeout("10 seconds")`.
   - On error or non-200 status, log warning and return original `results`.
   - Map each item: if `answers[key]?.noul >= threshold`, keep `Success`; otherwise `{ _tag: "Filtered", url: item.data.url }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/JevFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/JevFilter.ts test/features/link-preview/JevFilter.test.ts
git commit -m "link-preview: implement JevFilter using OpenRouter System One"
```

---

### Task 4: 在 `handleLinkPreviewMessage` 中集成 Jev 过滤

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts:482-554`
- Test: `test/features/link-preview/LinkPreviewBot.test.ts`

**Interfaces:**
- Updates `handleLinkPreviewMessage` pipeline:
  `scrapeAll -> filterPreviewResults -> formatPreview -> quote`

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/LinkPreviewBot.test.ts`**

Add tests:
1. Message with single link that is filtered by Jev: Bot stays silent (no `quote` called).
2. Message with multiple links where one is filtered and one passes: Bot sends quote reply with `1. （已过滤）\n2. <title>`.
3. When `OPENROUTER_API_KEY` is not set: Bot sends normal quote reply without filtering.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: FAIL on new tests verifying filtering behavior in `handleLinkPreviewMessage`.

- [ ] **Step 3: Update `handleLinkPreviewMessage` in `src/features/link-preview/LinkPreview.ts`**

1. Read `BotConfig` option:
   ```ts
   const config = yield* Effect.option(BotConfig);
   const openrouterApiKey =
     config._tag === "Some" ? config.value.openrouterApiKey : undefined;
   ```
2. After `scrapeAll(urls)`:
   ```ts
   const filteredResults = yield* filterPreviewResults(
     event.raw_message,
     results,
     openrouterApiKey,
   );
   const formatted = formatPreview(filteredResults);
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite, linter, and type checker**

Run:
- `bun test`
- `bun run check`
- `bun run lint`

- [ ] **Step 6: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewBot.test.ts
git commit -m "link-preview: integrate Jev filtering into link preview message flow"
```
