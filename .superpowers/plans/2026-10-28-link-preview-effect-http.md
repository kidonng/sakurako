# Link Preview Migration to effect/http and Tagged Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `LinkPreview.ts` from bare `fetch` to `effect/http`'s `HttpClient`, eliminate parameter drilling and unsafe `as unknown as typeof fetch` test mocks, and refactor scraping failures into structured domain Tagged Errors.

**Architecture:** Use `HttpClient.HttpClient` as an Effect Context dependency in `LinkPreview.ts` functions (`scrapeMetadata`, `prepareOutgoingImage`, `scrapeAll`, `handleLinkPreviewMessage`). Provide `FetchHttpClient.layer` at application startup in `src/index.ts`. Replace string error reasons with a `ScrapeMetadataError` Tagged Error union (`InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError`), and provide a type-safe `makeTestHttpClient` helper layer for tests.

**Tech Stack:** TypeScript 7, Bun, Effect 4 (`effect`, `effect/http`, `@effect/platform-bun`), Metascraper, `bun:test`.

**Spec:** `.superpowers/specs/2026-10-28-link-preview-effect-http-design.md`

## Global Constraints

- Use Effect 4 patterns: `Data.TaggedError` for domain errors; `Layer` and `Context.Service` for dependency provision.
- Strictly adhere to `verbatimModuleSyntax: true` using `import type { ... }` or explicit `type` modifiers.
- Strictly adhere to the "No any" policy; do not use `any` or `as any`.
- Local relative imports must include `.ts` extensions (e.g. `import { makeTestHttpClient } from "./TestHttpClient.ts"`).
- All commits must follow the Linux Kernel commit message style specified in `AGENTS.md`.

## Review Focus

1. **HTTP timeout cancellation**: Server hangs longer than 10s triggers `Effect.timeout("10 seconds")` and aborts request fiber, mapping to `HttpFetchError`.
2. **HTTP non-2xx status handling**: Responses with 4xx or 5xx status codes fail with `HttpFetchError` retaining `status` and `statusText`.
3. **SSRF protection on local and private addresses**: Private IPv4, IPv6, localhost, and `.internal` addresses fail with `BlockedHostError` before issuing any HTTP request.
4. **Base64 image download error resilience**: Failure to download image in `prepareOutgoingImage` logs a warning and gracefully resolves to `undefined` instead of failing the message handler.
5. **Multi-URL scraping failure reporting**: When some URLs fail and some succeed in a multi-URL message, `formatPreview` formats failures as `[提取失败：${error.message}]` while rendering successful previews.

---

### Task 1: Model Tagged Errors and Update `ScrapingResult` & `formatPreview`

**Files:**
- Modify: `src/LinkPreview.ts:70-135,175-215`
- Modify: `test/LinkPreviewFormat.test.ts:1-110`

**Interfaces:**
- Produces:
  - `InvalidUrlError`: `Data.TaggedError<"InvalidUrlError"> & { readonly url: string; readonly cause: unknown; readonly message: string }`
  - `BlockedHostError`: `Data.TaggedError<"BlockedHostError"> & { readonly url: string; readonly hostname: string; readonly message: string }`
  - `HttpFetchError`: `Data.TaggedError<"HttpFetchError"> & { readonly url: string; readonly status?: number; readonly statusText?: string; readonly detail: string; readonly message: string }`
  - `ParseMetadataError`: `Data.TaggedError<"ParseMetadataError"> & { readonly url: string; readonly cause: unknown; readonly message: string }`
  - `ScrapeMetadataError`: `InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError`
  - `ScrapingResult`: `{ readonly _tag: "Success"; readonly data: PageMetadata } | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError }`
  - `formatPreview`: `(results: ReadonlyArray<ScrapingResult>) => FormattedPreview | null` (renders `item.error.message` on Failure)

- [ ] **Step 1: Write failing test in `test/LinkPreviewFormat.test.ts` for Tagged Error formatted preview**

Update `test/LinkPreviewFormat.test.ts` to construct `Failure` using `HttpFetchError` and `BlockedHostError`:
```ts
it("formats multiple URLs with mixed successes and failures using TaggedError message", () => {
  const results: ScrapingResult[] = [
    {
      _tag: "Success",
      data: { url: "https://success.com", title: "Success Title" },
    },
    {
      _tag: "Failure",
      url: "https://fail.com",
      error: new HttpFetchError({
        url: "https://fail.com",
        status: 404,
        statusText: "Not Found",
        detail: "HTTP status 404",
      }),
    },
    {
      _tag: "Failure",
      url: "http://127.0.0.1",
      error: new BlockedHostError({
        url: "http://127.0.0.1",
        hostname: "127.0.0.1",
      }),
    },
  ];
  const formatted = formatPreview(results);
  expect(formatted?.text).toBe(
    "1. Success Title\n2. [提取失败：HTTP 404 Not Found]\n3. [提取失败：Blocked private or local address]",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/LinkPreviewFormat.test.ts`
Expected: FAIL due to `HttpFetchError` not exported or `item.reason` undefined in `formatPreview`.

- [ ] **Step 3: Define Tagged Errors and update `ScrapingResult` & `formatPreview` in `src/LinkPreview.ts`**

In `src/LinkPreview.ts`:
1. Define `InvalidUrlError`, `BlockedHostError`, `HttpFetchError`, `ParseMetadataError` using `Data.TaggedError`.
2. Export `type ScrapeMetadataError = InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError`.
3. Update `ScrapingResult`:
   ```ts
   export type ScrapingResult =
     | { readonly _tag: "Success"; readonly data: PageMetadata }
     | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError };
   ```
4. Update `formatPreview`: replace `item.reason` with `item.error.message`.
5. Update existing tests in `test/LinkPreviewFormat.test.ts` to use `new HttpFetchError(...)` instead of raw `{ reason: ... }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/LinkPreviewFormat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/LinkPreview.ts test/LinkPreviewFormat.test.ts
git commit -m "link-preview: model scraping failures as domain Tagged Errors

### Problem

Link preview failures currently use untyped arbitrary string reasons in
ScrapingResult, forcing tests to rely on brittle substring matching and
obscuring error classification.

### Solution

Introduce a closed union of Data.TaggedError classes (InvalidUrlError,
BlockedHostError, HttpFetchError, ParseMetadataError) under
ScrapeMetadataError. Update ScrapingResult and formatPreview to consume
typed error instances while preserving human-readable message formatting.

### References

Spec: .superpowers/specs/2026-10-28-link-preview-effect-http-design.md"
```

---

### Task 2: Create `TestHttpClient` Helper

**Files:**
- Create: `test/TestHttpClient.ts`

**Interfaces:**
- Produces:
  - `makeTestHttpClient`: `(handler: (request: HttpClientRequest.HttpClientRequest) => Response | Promise<Response>) => Layer.Layer<HttpClient.HttpClient>`

- [ ] **Step 1: Write test for `makeTestHttpClient` in `test/TestHttpClient.test.ts`**

Create `test/TestHttpClient.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { makeTestHttpClient } from "./TestHttpClient.ts";

describe("makeTestHttpClient", () => {
  it("provides mock response to HttpClient.HttpClient", async () => {
    const layer = makeTestHttpClient((req) => {
      expect(req.url).toBe("https://example.com/test");
      return new Response("mock response body", { status: 200 });
    });

    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get("https://example.com/test");
      const text = yield* res.text;
      return { status: res.status, text };
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ status: 200, text: "mock response body" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/TestHttpClient.test.ts`
Expected: FAIL with `Cannot find module './TestHttpClient.ts'`.

- [ ] **Step 3: Implement `makeTestHttpClient` in `test/TestHttpClient.ts`**

Create `test/TestHttpClient.ts`:
```ts
import { Effect, Layer } from "effect";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export function makeTestHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Response | Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.tryPromise({
        try: async () => {
          const webResponse = await handler(request);
          return HttpClientResponse.fromWeb(request, webResponse);
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.fail(
            new HttpClient.HttpClientError({
              reason: new HttpClient.RequestError({
                request,
                cause,
                description: String(cause),
              }),
            }),
          ),
        ),
      ),
    ),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/TestHttpClient.test.ts`
Expected: PASS

- [ ] **Step 5: Clean up temporary test file and commit**

Remove `test/TestHttpClient.test.ts` and commit `test/TestHttpClient.ts`:
```bash
rm test/TestHttpClient.test.ts
git add test/TestHttpClient.ts
git commit -m "test: add makeTestHttpClient helper for mock HTTP layers

### Problem

Unit tests for link preview currently pass mock fetch functions double-cast
as 'mockFetch as unknown as typeof fetch', which violates type safety and
prevents idiomatic Effect Layer dependency injection.

### Solution

Create makeTestHttpClient in test/TestHttpClient.ts which constructs an
HttpClient.HttpClient layer backed by a user-supplied Request to Response
handler, bridging native web Responses into HttpClientResponse.

### References

Spec: .superpowers/specs/2026-10-28-link-preview-effect-http-design.md"
```

---

### Task 3: Refactor `LinkPreview.ts` to `effect/http` & Wire `src/index.ts`

**Files:**
- Modify: `src/LinkPreview.ts:275-480`
- Modify: `src/index.ts:1-24`

**Interfaces:**
- Consumes:
  - `HttpClient.HttpClient` from `effect/http`
  - `makeTestHttpClient` from `test/TestHttpClient.ts`
- Produces:
  - `scrapeMetadata`: `(url: string) => Effect.Effect<PageMetadata, ScrapeMetadataError, HttpClient.HttpClient>`
  - `prepareOutgoingImage`: `(imageUrl: string) => Effect.Effect<string | undefined, never, HttpClient.HttpClient>`
  - `scrapeAll`: `(urls: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient>`
  - `handleLinkPreviewMessage`: `(item: IncomingMessage) => Effect.Effect<void, never, HttpClient.HttpClient>`

- [ ] **Step 1: Write integration test exercising `scrapeMetadata` and `prepareOutgoingImage` with `HttpClient`**

In `test/LinkPreviewEngine.test.ts`, add a test verifying `scrapeMetadata` and `prepareOutgoingImage` when provided with `makeTestHttpClient`:
```ts
it("fetches metadata using HttpClient service layer", async () => {
  const layer = makeTestHttpClient(() =>
    new Response(
      "<html><head><title>Effect Http Title</title><meta name=\"description\" content=\"Effect Http Desc\"></head></html>",
      { status: 200 },
    )
  );
  const result = await Effect.runPromise(
    scrapeMetadata("https://example.com/effect").pipe(Effect.provide(layer)),
  );
  expect(result.title).toBe("Effect Http Title");
  expect(result.description).toBe("Effect Http Desc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/LinkPreviewEngine.test.ts`
Expected: FAIL (compilation or execution failure due to old signature and missing HttpClient integration).

- [ ] **Step 3: Refactor `src/LinkPreview.ts` and `src/index.ts`**

1. In `src/LinkPreview.ts`:
   - Import `HttpClient`, `HttpClientRequest` from `effect/http`.
   - Update `scrapeMetadata`:
     - Access `client = yield* HttpClient.HttpClient`.
     - Check `isPrivateHost(urlObj.hostname)` -> fail with `new BlockedHostError({ url, hostname: urlObj.hostname })`.
     - Construct request: `HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)))`.
     - Execute request with timeout: `client.execute(req).pipe(Effect.timeout("10 seconds"))`.
     - On timeout or network failure -> fail with `HttpFetchError`.
     - If `response.status < 200 || response.status >= 300` -> fail with `HttpFetchError` retaining `status` and `statusText`.
     - Read body: `yield* response.text.pipe(...)`.
     - Pass `targetUrl = response.url || url` to `scraper(...)`. On parse failure -> fail with `ParseMetadataError`.
     - Remove `fetchFn` parameter.
   - Update `prepareOutgoingImage`:
     - Access `client = yield* HttpClient.HttpClient`.
     - Remove `fetchFn` parameter.
     - Fetch image with `client.execute(req).pipe(Effect.timeout("10 seconds"))`.
     - Read buffer with `yield* response.arrayBuffer`.
     - Convert to `base64://${Buffer.from(buffer).toString("base64")}`.
   - Update `scrapeAll(urls: ReadonlyArray<string>)`:
     - Call `scrapeMetadata(url)`. On failure, produce `{ _tag: "Failure", url, error: reason }`.
     - Remove `fetchFn` parameter.
   - Update `handleLinkPreviewMessage(item: IncomingMessage)`:
     - Remove `fetchFn` parameter.
     - Calls `scrapeAll` and `prepareOutgoingImage` without passing `fetchFn`.
2. In `src/index.ts`:
   - Import `FetchHttpClient` from `effect/http`.
   - Provide `FetchHttpClient.layer` to `MainLive`:
     ```ts
     const MainLive = MainProgram.pipe(
       Effect.provide(SnowLumaClient.layer),
       Effect.provide(FetchHttpClient.layer),
     );
     ```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/LinkPreviewEngine.test.ts -t "fetches metadata using HttpClient service layer"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/LinkPreview.ts src/index.ts test/LinkPreviewEngine.test.ts
git commit -m "link-preview: migrate scraping and image download to effect/http

### Problem

Link preview used raw global fetch and prop-drilled fetchFn parameters,
diverging from Effect 4 service-oriented architecture and complicating
downstream consumers.

### Solution

Replace raw fetch with HttpClient.HttpClient from effect/http across
scrapeMetadata, prepareOutgoingImage, scrapeAll, and handleLinkPreviewMessage.
Provide FetchHttpClient.layer at the application root in src/index.ts.

### References

Spec: .superpowers/specs/2026-10-28-link-preview-effect-http-design.md"
```

---

### Task 4: Migrate `LinkPreviewEngine.test.ts` & `LinkPreviewBot.test.ts` Test Suites

**Files:**
- Modify: `test/LinkPreviewEngine.test.ts`
- Modify: `test/LinkPreviewBot.test.ts`

**Interfaces:**
- Consumes:
  - `makeTestHttpClient` from `test/TestHttpClient.ts`
  - `BlockedHostError`, `HttpFetchError` from `src/LinkPreview.ts`

- [ ] **Step 1: Check existing test failures after signature change**

Run: `bun test test/LinkPreviewEngine.test.ts test/LinkPreviewBot.test.ts`
Expected: Compile / type / test errors where tests still pass `mockFetch as unknown as typeof fetch`.

- [ ] **Step 2: Update `test/LinkPreviewEngine.test.ts`**

1. Replace all `mockFetch as unknown as typeof fetch` parameter passing with `.pipe(Effect.provide(makeTestHttpClient(...)))`.
2. Update SSRF tests:
   ```ts
   const error = await Effect.runPromise(
     scrapeMetadata("http://localhost:3000").pipe(
       Effect.provide(makeTestHttpClient(() => new Response(""))),
       Effect.flip,
     ),
   );
   expect(error._tag).toBe("BlockedHostError");
   expect(error.message).toBe("Blocked private or local address");
   ```
3. Update non-200 HTTP status test:
   ```ts
   const program = scrapeMetadata("https://example.com/missing").pipe(
     Effect.provide(makeTestHttpClient(() => new Response("Not Found", { status: 404, statusText: "Not Found" }))),
   );
   const error = await Effect.runPromise(program.pipe(Effect.flip));
   expect(error._tag).toBe("HttpFetchError");
   expect(error.status).toBe(404);
   expect(error.message).toContain("HTTP 404");
   ```
4. Update `scrapeAll` tests to verify `second.error._tag === "HttpFetchError"` and `second.error.status === 500`.

- [ ] **Step 3: Update `test/LinkPreviewBot.test.ts`**

1. In each test calling `handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch)`:
   - Provide the test layer: `.pipe(Effect.provide(makeTestHttpClient(mockHandler)))`.
2. Ensure tests checking `fetchCalled = false` verify that the request handler was not invoked.

- [ ] **Step 4: Run full test suite, type check, and lint**

Run:
1. `bun test` (all tests must pass)
2. `bun run check` (TypeScript compilation must pass with 0 errors)
3. `bun run lint` (oxlint must pass with 0 errors)

- [ ] **Step 5: Commit**

```bash
git add test/LinkPreviewEngine.test.ts test/LinkPreviewBot.test.ts
git commit -m "test: migrate link preview test suites to makeTestHttpClient

### Problem

Test suites passed mockFetch through function arguments double-cast as
'as unknown as typeof fetch' and relied on string matching for error
verification.

### Solution

Update LinkPreviewEngine and LinkPreviewBot test suites to inject mock HTTP
responses via makeTestHttpClient layers. Assert directly on TaggedError tags
(_tag) and structured properties (status, message).

### References

Spec: .superpowers/specs/2026-10-28-link-preview-effect-http-design.md"
```
