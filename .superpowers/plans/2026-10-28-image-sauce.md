# Image Sauce & Directory Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` to group modules under `src/features/` and implement the SauceNao-based `/sauce` image source lookup feature with quote replies.

**Architecture:** Features are modularized into `src/features/echo/`, `src/features/link-preview/`, and `src/features/sauce/`. `SauceNao.ts` encapsulates API calls and data normalization via Effect `HttpClient.HttpClient`, while `Sauce.ts` handles OneBot message trigger parsing, quote extraction via `SnowLumaClient.client.getMessage`, and quote reply dispatch.

**Tech Stack:** TypeScript 5/7, Bun 1.4, Effect 4 (`effect`, `@effect/platform-bun`, `effect/http`), `@snowluma/sdk`.

**Spec:** `.superpowers/specs/2026-10-28-image-sauce-design.md`

## Global Constraints

- Pinned Bun runtime (`1.4.4-canary`), native ESM with `verbatimModuleSyntax: true` and `.ts` extension in relative imports.
- Use Effect 4 idioms (`Effect.gen`, `HttpClient`, `Config`, `Schema`).
- Never use global `fetch` or `as any`. Use `makeTestHttpClient` for HTTP mocking and domain interfaces / double-casting for SDK objects.
- All errors in `handleSauceMessage` must be caught per-message to prevent terminating the main stream.
- Lint and typecheck must pass (`bun run check`, `bun run lint`).

## Review Focus

1. **Auto-injected `@author` in QQ group replies**: When quoting another user in group chat, QQ client prepends `[CQ:at,qq=...]` alongside `[CQ:reply,id=...]`. Ensure non-bot `@` segments are stripped so that `/sauce` matches properly. (Covered in Task 4)
2. **Missing external URLs in search result**: SauceNao anime screenshot or local index entries might have no `ext_urls`. The reply formatter must omit the URL line instead of printing `undefined` or a blank line. (Covered in Task 3)
3. **Similarity below threshold**: When SauceNao returns matches below `header.minimum_similarity`, it must be treated as no match and reply "未找到相似度较高的图片来源". (Covered in Task 3 & 4)
4. **Quoted message with multiple image segments**: When quoted message has multiple images, only the first image must be extracted and searched. (Covered in Task 4)
5. **SauceNao API or network failure**: Network timeout or quota exhaustion must not crash the event loop and must reply "查询失败，请稍后重试". (Covered in Task 4)

---

### Task 1: Reorganize Directory Structure to `src/features/` and `src/utils/`

**Files:**
- Move:
  - `src/EchoBot.ts` -> `src/features/echo/EchoBot.ts`
  - `src/LinkPreview.ts` -> `src/features/link-preview/LinkPreview.ts`
  - `src/LinkPreviewSites.ts` -> `src/features/link-preview/LinkPreviewSites.ts`
  - `src/TextWidth.ts` -> `src/utils/TextWidth.ts`
  - `test/EchoBot.test.ts` -> `test/features/echo/EchoBot.test.ts`
  - `test/LinkPreviewBot.test.ts` -> `test/features/link-preview/LinkPreviewBot.test.ts`
  - `test/LinkPreviewEngine.test.ts` -> `test/features/link-preview/LinkPreviewEngine.test.ts`
  - `test/LinkPreviewFormat.test.ts` -> `test/features/link-preview/LinkPreviewFormat.test.ts`
  - `test/LinkPreviewSites.test.ts` -> `test/features/link-preview/LinkPreviewSites.test.ts`
  - `test/TextWidth.test.ts` -> `test/utils/TextWidth.test.ts`
- Modify:
  - `src/index.ts`
  - `src/features/link-preview/LinkPreview.ts`
  - `test/features/echo/EchoBot.test.ts`
  - `test/features/link-preview/LinkPreviewBot.test.ts`
  - `test/features/link-preview/LinkPreviewEngine.test.ts`
  - `test/features/link-preview/LinkPreviewFormat.test.ts`
  - `test/features/link-preview/LinkPreviewSites.test.ts`
  - `test/utils/TextWidth.test.ts`

**Interfaces:**
- Consumes: Existing exports from moved modules.
- Produces: Updated import paths with identical public symbols.

- [ ] **Step 1: Move source files and test files to their new locations**

```bash
mkdir -p src/features/echo src/features/link-preview src/utils
mkdir -p test/features/echo test/features/link-preview test/utils

git mv src/EchoBot.ts src/features/echo/EchoBot.ts
git mv src/LinkPreview.ts src/features/link-preview/LinkPreview.ts
git mv src/LinkPreviewSites.ts src/features/link-preview/LinkPreviewSites.ts
git mv src/TextWidth.ts src/utils/TextWidth.ts

git mv test/EchoBot.test.ts test/features/echo/EchoBot.test.ts
git mv test/LinkPreviewBot.test.ts test/features/link-preview/LinkPreviewBot.test.ts
git mv test/LinkPreviewEngine.test.ts test/features/link-preview/LinkPreviewEngine.test.ts
git mv test/LinkPreviewFormat.test.ts test/features/link-preview/LinkPreviewFormat.test.ts
git mv test/LinkPreviewSites.test.ts test/features/link-preview/LinkPreviewSites.test.ts
git mv test/TextWidth.test.ts test/utils/TextWidth.test.ts
```

- [ ] **Step 2: Update import paths across moved files, `src/index.ts`, and test files**

Update imports:
- In `src/features/echo/EchoBot.ts`: `./SnowLuma.ts` -> `../../SnowLuma.ts`
- In `src/features/link-preview/LinkPreview.ts`: `./SnowLuma.ts` -> `../../SnowLuma.ts`, `./TextWidth.ts` -> `../../utils/TextWidth.ts`
- In `src/index.ts`: `./EchoBot.ts` -> `./features/echo/EchoBot.ts`, `./LinkPreview.ts` -> `./features/link-preview/LinkPreview.ts`
- In test files: update relative imports pointing to `src/` and `test/TestHttpClient.ts`.

- [ ] **Step 3: Run test suite, typecheck, and linter to verify migration**

Run:
```bash
bun test
bun run check
bun run lint
```
Expected: All tests PASS, 0 type errors, 0 linter warnings.

- [ ] **Step 4: Commit directory reorganization**

```bash
git add src test
git commit -m "refactor: reorganize src and test into feature and utility modules

### Problem

All business features and helper modules were flattened directly under
src/, making file navigation and separation of concerns difficult as
new features are added.

### Solution

Move EchoBot into src/features/echo/, LinkPreview into
src/features/link-preview/, and TextWidth into src/utils/, updating
corresponding test directories and import references.

### References

.superpowers/specs/2026-10-28-image-sauce-design.md"
```

---

### Task 2: Add SauceNao API Key to Configuration

**Files:**
- Modify: `src/Config.ts`
- Modify: `.env.example`
- Modify: `test/Config.test.ts`

**Interfaces:**
- Consumes: `effect/Config`, `effect/Redacted`
- Produces: `sauceNaoApiKey?: Redacted.Redacted<string>` in `BotConfig`

- [ ] **Step 1: Write failing test in `test/Config.test.ts` for `sauceNaoApiKey`**

```ts
it("reads optional SAUCENAO_API_KEY when provided", async () => {
  const config = await Effect.runPromise(
    BotConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            SNOWLUMA_WS_URL: "ws://localhost:3001",
            SNOWLUMA_ACCESS_TOKEN: "token",
            SAUCENAO_API_KEY: "my_api_key",
          }),
        ),
      ),
    ),
  );
  expect(config.sauceNaoApiKey).toBeDefined();
  expect(Redacted.value(config.sauceNaoApiKey!)).toBe("my_api_key");
});

it("defaults sauceNaoApiKey to undefined when omitted", async () => {
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
  expect(config.sauceNaoApiKey).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/Config.test.ts`
Expected: FAIL with type or property assertion error.

- [ ] **Step 3: Implement `sauceNaoApiKey` in `src/Config.ts` and update `.env.example`**

In `src/Config.ts`:
```ts
export interface BotConfig {
  readonly wsUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly sauceNaoApiKey?: Redacted.Redacted<string>;
}

export const BotConfig: Config.Config<BotConfig> = Config.all({
  wsUrl: Config.String("SNOWLUMA_WS_URL").pipe(
    Config.withDefault("ws://snowluma.orb.local:3001/"),
  ),
  accessToken: Config.Redacted("SNOWLUMA_ACCESS_TOKEN"),
  sauceNaoApiKey: Config.option(Config.Redacted("SAUCENAO_API_KEY")).pipe(
    Config.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
  ),
});
```
Update `.env.example` with commented `SAUCENAO_API_KEY` example.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/Config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit configuration change**

```bash
git add src/Config.ts .env.example test/Config.test.ts
git commit -m "config: add optional SAUCENAO_API_KEY to BotConfig

### Problem

SauceNao search requires an optional API key to grant higher request
quotas without forcing users to register for low-volume testing.

### Solution

Add sauceNaoApiKey as an optional Redacted string in BotConfig,
defaulting to undefined when the environment variable is unset.

### References

.superpowers/specs/2026-10-28-image-sauce-design.md"
```

---

### Task 3: Implement SauceNao Client & Metadata Extraction

**Files:**
- Create: `src/features/sauce/SauceNao.ts`
- Create: `test/features/sauce/SauceNao.test.ts`

**Interfaces:**
- Consumes: `effect/http/HttpClient`, `effect/http/HttpClientRequest`, `effect/Data`, `effect/Effect`, `effect/Redacted`
- Produces:
  ```ts
  export interface SauceResult {
    readonly title: string;
    readonly author?: string;
    readonly url?: string;
    readonly formattedText: string;
    readonly similarity: number;
  }
  export class SauceNaoError extends Data.TaggedError("SauceNaoError")<{
    readonly cause: unknown;
  }> {}
  export function searchSauce(
    imageUrl: string,
    apiKey?: Redacted.Redacted<string>,
  ): Effect.Effect<SauceResult | null, SauceNaoError, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write unit tests in `test/features/sauce/SauceNao.test.ts`**

Cover the following test cases using `makeTestHttpClient`:
1. Pixiv result with title, `member_name`, `ext_urls`, and similarity >= minimum similarity. Verifies `formattedText` is `${title} by ${member_name}\n${url}`.
2. Anime screenshot with `source`, `part`, `ext_urls`, no author. Verifies `formattedText` is `${title}\n${url}`.
3. Result with no external URL. Verifies `formattedText` is `${title} by ${author}` without trailing newline or undefined.
4. Result with similarity below `minimum_similarity`. Verifies returns `null`.
5. Empty results array. Verifies returns `null`.
6. Non-zero status header (API error) or HTTP error. Verifies fails with `SauceNaoError`.
7. Inclusion of `api_key` param when `apiKey` is provided.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `src/features/sauce/SauceNao.ts`**

Implementation details:
- Define `SauceResult`, `SauceNaoError`.
- Build URL with query params (`db=999`, `output_type=2`, `numres=1`, `url=encodeURIComponent(imageUrl)`, optional `api_key`).
- Use `HttpClientRequest.get(endpoint)` and `client.execute(...)`, parse JSON response via `response.json`.
- Check `header.status === 0`, parse `minimum_similarity` (float) and `results[0].header.similarity` (float).
- Return `null` if no results or `similarity < minimum_similarity`.
- Extract title: `data.title || data.source (with part if present) || data.material || data.jp_name || "未知标题"`.
- Extract author: `data.member_name || data.author_name || data.creator || data.twitter_user_name`.
- Extract url: `data.ext_urls?.[0] || (data.pixiv_id ? 'https://www.pixiv.net/artworks/' + data.pixiv_id : undefined)`.
- Format `formattedText`:
  - With author: `${title} by ${author}`
  - Without author: `${title}`
  - If url present: `${headerText}\n${url}`, else `${headerText}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: PASS.

- [ ] **Step 5: Run linter and typecheck**

Run:
```bash
bun run check
bun run lint
```
Expected: PASS.

- [ ] **Step 6: Commit SauceNao module**

```bash
git add src/features/sauce/SauceNao.ts test/features/sauce/SauceNao.test.ts
git commit -m "feat(sauce): implement SauceNao search client and metadata normalizer

### Problem

Image source lookup requires querying SauceNao and parsing varied
metadata formats across different illustration, anime, and manga indices.

### Solution

Implement searchSauce using Effect's HttpClient, validating similarity
against minimum_similarity, extracting title, author, and external URL,
and formatting output with fallback rules for missing URLs or authors.

### References

.superpowers/specs/2026-10-28-image-sauce-design.md"
```

---

### Task 4: Implement Sauce Bot Handler (`src/features/sauce/Sauce.ts`)

**Files:**
- Create: `src/features/sauce/Sauce.ts`
- Create: `test/features/sauce/SauceBot.test.ts`

**Interfaces:**
- Consumes: `src/features/sauce/SauceNao.ts`, `src/SnowLuma.ts`, `src/Config.ts`, `effect/http/HttpClient`
- Produces:
  ```ts
  export function handleSauceMessage(
    item: IncomingMessage,
  ): Effect.Effect<void, never, HttpClient.HttpClient | SnowLumaClient | BotConfig>;
  ```

- [ ] **Step 1: Write unit tests in `test/features/sauce/SauceBot.test.ts`**

Cover:
1. Message strictly matching `/sauce` quoting an image: calls `client.getMessage`, calls `searchSauce`, quotes reply with formatted text.
2. Quoted message with multiple image segments: extracts and searches the first image segment.
3. Message strictly matching `/sauce` in group chat with auto-prepended `@author` and `reply`: successfully triggers search.
4. Message strictly matching `/sauce` without a quote `reply` segment: quotes reply `"未在引用的消息中找到图片"`.
5. Message quoting a message that has no image segments: quotes reply `"未在引用的消息中找到图片"`.
6. Message quoting an image, but SauceNao returns `null` (low similarity / no match): quotes reply `"未找到相似度较高的图片来源"`.
7. Message quoting an image, but SauceNao or `getMessage` fails: quotes reply `"查询失败，请稍后重试"`.
8. Messages not strictly matching `/sauce` (e.g. `/sauce help`, `sauce`, `/sauce ` with non-whitespace text): does nothing.
9. Loop guard: message sent by self (`user_id === self_id` or `post_type === "message_sent"`) does nothing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/sauce/SauceBot.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `src/features/sauce/Sauce.ts`**

Implementation details:
- Loop prevention check: `if (event.post_type === "message_sent" || event.user_id === event.self_id) return Effect.void;`
- Segment parsing: support array `event.message` or `parseSegments(event.raw_message)`.
- Strip `reply` segment and all `at` segments, extract text segments, trim:
  - If text !== `"/sauce"`, return `Effect.void`.
- Extract `reply` segment:
  - If no reply segment: reply `context.quote("未在引用的消息中找到图片")`.
- If reply segment found:
  - Call `client.client.getMessage(Number(reply.data.id))`.
  - Extract message payload from response, parse into segments.
  - Find first segment with `type === "image"`.
  - If no image: reply `context.quote("未在引用的消息中找到图片")`.
  - If image found: take `segment.data.url ?? segment.data.file`.
  - Call `searchSauce(imageUrl, config.sauceNaoApiKey)`.
  - If `result` found: `context.quote(result.formattedText)`.
  - If `result === null`: `context.quote("未找到相似度较高的图片来源")`.
  - Wrap entire effect in `Effect.catchAll` logging error and calling `context.quote("查询失败，请稍后重试")` (with fallback to log if quoting fails).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/sauce/SauceBot.test.ts`
Expected: PASS.

- [ ] **Step 5: Run linter and typecheck**

Run:
```bash
bun run check
bun run lint
```
Expected: PASS.

- [ ] **Step 6: Commit Sauce Bot module**

```bash
git add src/features/sauce/Sauce.ts test/features/sauce/SauceBot.test.ts
git commit -m "feat(sauce): implement OneBot /sauce quote handler

### Problem

Users in QQ need to trigger image source searches by quoting an image
message and sending /sauce, receiving meaningful status feedback on
failures or missing images.

### Solution

Implement handleSauceMessage to strictly match /sauce after stripping
reply and mention segments, retrieve the quoted message via
SnowLumaClient, query SauceNao for the first image, and reply with the
result or specific failure notices.

### References

.superpowers/specs/2026-10-28-image-sauce-design.md"
```

---

### Task 5: Mount Sauce Handler to Main Entrypoint & Final Verification

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `src/features/sauce/Sauce.ts` (`handleSauceMessage`), `src/Config.ts` (`BotConfig`)
- Produces: Live application entrypoint concurrently processing Echo, LinkPreview, and Sauce messages.

- [ ] **Step 1: Mount `handleSauceMessage` in `src/index.ts`**

Update `src/index.ts`:
```ts
import { handleSauceMessage } from "./features/sauce/Sauce.ts";
```
In `Stream.runForEach`:
```ts
Stream.runForEach((item) =>
  Effect.all(
    [
      handleIncomingMessage(item),
      handleLinkPreviewMessage(item),
      handleSauceMessage(item),
    ],
    {
      concurrency: "unbounded",
    },
  ).pipe(Effect.asVoid),
)
```
Provide `BotConfig` if needed (or `SnowLumaClient` context).

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Run full typecheck and lint**

Run:
```bash
bun run check
bun run lint
bun run format
```
Expected: 0 errors, 0 warnings, cleanly formatted.

- [ ] **Step 4: Commit entrypoint integration**

```bash
git add src/index.ts
git commit -m "feat: mount handleSauceMessage into message stream

### Problem

Sauce handler was implemented and tested but not yet mounted to the
primary message consumer stream in the bot entrypoint.

### Solution

Add handleSauceMessage to the concurrent Effect.all consumer list in
src/index.ts alongside EchoBot and LinkPreview.

### References

.superpowers/specs/2026-10-28-image-sauce-design.md"
```
