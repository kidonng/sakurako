# HTTP Tagged Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor monolithic `HttpFetchError` in `src/utils/HttpClient.ts` into a discriminated union of typed `Schema.TaggedError` classes, and migrate call sites (`DanbooruClient`, `LinkPreviewSites`, `LinkPreview`) to use Effect's `catchTag` / `catchTags`.

**Architecture:** Define `HttpNotFoundError` (404), `HttpNoContentError` (204), `HttpRateLimitError` (429), `HttpClientStatusError` (other 4xx), `HttpServerStatusError` (5xx), `HttpTimeoutError`, and `HttpNetworkError` under `HttpFetchError` union. Auto-classify responses in `executeWithResponse`, `fetchJson`, and `fetchText`. Migrate `DanbooruClient` and `LinkPreviewSites` to eliminate procedural status inspection and remove dead code.

**Tech Stack:** TypeScript 7, Bun 1.4, Effect 4 (`effect`, `effect/http`, `effect/schema`), `bun:test`.

**Spec:** `.superpowers/specs/2026-11-09-http-tagged-errors-design.md`

## Global Constraints

- Pinned Bun 1.4 runtime with native ESM and `verbatimModuleSyntax: true`.
- All local relative imports must include `.ts` extensions.
- All `Schema.TaggedError` classes must include `{ readonly brand: unique symbol }` as second type parameter.
- Never use `any` or `as any`.
- Never mock global `fetch`; use `makeTestHttpClient` for testing.
- Follow Linux Kernel commit message style (Problem, Solution, References).
- All changes must pass `bun test`, `bun run check`, `bun run lint`, and `bun run knip`.

## Review Focus

- HTTP 404 status: Must yield `HttpNotFoundError` with status 404 and safely cancel unread response body.
- HTTP 204 status in `fetchJson`: Must reject with `HttpNoContentError` instead of crashing on JSON parse.
- HTTP 429 status: Must yield `HttpRateLimitError` with status 429 and safely cancel unread response body.
- Other 4xx status: Must yield `HttpClientStatusError` retaining original status.
- 5xx status: Must yield `HttpServerStatusError` retaining original status.

---

### Task 1: Implement HTTP Tagged Errors in `src/utils/HttpClient.ts`

**Files:**
- Modify: `src/utils/HttpClient.ts`
- Modify: `test/utils/HttpClient.test.ts`

**Interfaces:**
- Produces:
  - `HttpNotFoundError`: `Schema.TaggedError<HttpNotFoundError, { readonly brand: unique symbol }>()("HttpNotFoundError", ...)`
  - `HttpNoContentError`: `Schema.TaggedError<HttpNoContentError, { readonly brand: unique symbol }>()("HttpNoContentError", ...)`
  - `HttpRateLimitError`: `Schema.TaggedError<HttpRateLimitError, { readonly brand: unique symbol }>()("HttpRateLimitError", ...)`
  - `HttpClientStatusError`: `Schema.TaggedError<HttpClientStatusError, { readonly brand: unique symbol }>()("HttpClientStatusError", ...)`
  - `HttpServerStatusError`: `Schema.TaggedError<HttpServerStatusError, { readonly brand: unique symbol }>()("HttpServerStatusError", ...)`
  - `HttpTimeoutError`: `Schema.TaggedError<HttpTimeoutError, { readonly brand: unique symbol }>()("HttpTimeoutError", ...)`
  - `HttpNetworkError`: `Schema.TaggedError<HttpNetworkError, { readonly brand: unique symbol }>()("HttpNetworkError", ...)`
  - `type HttpFetchError = HttpNotFoundError | HttpNoContentError | HttpRateLimitError | HttpClientStatusError | HttpServerStatusError | HttpTimeoutError | HttpNetworkError`

- [ ] **Step 1: Write the failing tests in `test/utils/HttpClient.test.ts`**

Update `test/utils/HttpClient.test.ts` to test each specific error class:
```ts
it("fails with HttpNotFoundError on 404 status and cancels response body", async () => {
  let bodyCancelled = false;
  const layer = makeTestHttpClient(() => {
    const stream = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(stream, {
      status: 404,
      statusText: "Not Found",
    });
  });

  const program = fetchText(
    HttpClientRequest.get("https://example.com/missing"),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );

  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpNotFoundError);
  expect(error._tag).toBe("HttpNotFoundError");
  expect(error.status).toBe(404);
  expect(error.statusText).toBe("Not Found");
  expect(error.message).toContain("HTTP 404 Not Found");
  expect(bodyCancelled).toBe(true);
});

it("fails with HttpRateLimitError on 429 status and cancels response body", async () => {
  const layer = makeTestHttpClient(() => new Response("Rate Limited", { status: 429 }));
  const program = fetchText(
    HttpClientRequest.get("https://example.com/api"),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );
  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpRateLimitError);
  expect(error._tag).toBe("HttpRateLimitError");
  expect(error.status).toBe(429);
});

it("fails with HttpClientStatusError on other 4xx status", async () => {
  const layer = makeTestHttpClient(() => new Response("Forbidden", { status: 403 }));
  const program = fetchText(
    HttpClientRequest.get("https://example.com/api"),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );
  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpClientStatusError);
  expect(error._tag).toBe("HttpClientStatusError");
  expect(error.status).toBe(403);
});

it("fails with HttpServerStatusError on 5xx status", async () => {
  const layer = makeTestHttpClient(() => new Response("Server Error", { status: 500 }));
  const program = fetchText(
    HttpClientRequest.get("https://example.com/api"),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );
  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpServerStatusError);
  expect(error._tag).toBe("HttpServerStatusError");
  expect(error.status).toBe(500);
});

it("fails with HttpNoContentError when fetchJson receives 204", async () => {
  const layer = makeTestHttpClient(() => new Response(null, { status: 204 }));
  const program = fetchJson(
    HttpClientRequest.get("https://example.com/empty"),
    Schema.Struct({ id: Schema.Number }),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );
  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpNoContentError);
  expect(error._tag).toBe("HttpNoContentError");
  expect(error.status).toBe(204);
});

it("fails with HttpTimeoutError when request times out", async () => {
  const layer = makeTestHttpClient(() => {
    const stream = new ReadableStream({
      start() {
        // never resolves
      },
    });
    return new Response(stream, { status: 200 });
  });

  const program = fetchText(
    HttpClientRequest.get("https://example.com/timeout"),
    { timeoutDuration: "50 millis" },
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );

  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpTimeoutError);
  expect(error._tag).toBe("HttpTimeoutError");
});

it("fails with HttpNetworkError when response body read fails", async () => {
  const layer = makeTestHttpClient(() => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    return new Response(stream, { status: 200 });
  });

  const program = fetchText(
    HttpClientRequest.get("https://example.com/socket-error"),
  ).pipe(
    Effect.provide(layer),
    Effect.flip,
  );

  const error = await Effect.runPromise(program);
  expect(error).toBeInstanceOf(HttpNetworkError);
  expect(error._tag).toBe("HttpNetworkError");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/utils/HttpClient.test.ts`
Expected: FAIL because new error classes do not exist.

- [ ] **Step 3: Implement new Tagged Errors and auto-classification in `src/utils/HttpClient.ts`**

Define `HttpNotFoundError`, `HttpNoContentError`, `HttpRateLimitError`, `HttpClientStatusError`, `HttpServerStatusError`, `HttpTimeoutError`, and `HttpNetworkError`.
Update `executeWithResponse`:
- Classify non-2xx status codes into `HttpNotFoundError` (404), `HttpRateLimitError` (429), `HttpServerStatusError` (>= 500), and `HttpClientStatusError` (< 500).
- Map `Cause.isTimeoutError` to `HttpTimeoutError`.
- Map `client.execute` transport errors to `HttpNetworkError`.
Update `fetchJson`:
- Check `if (response.status === 204)`: cancel response and yield `new HttpNoContentError({ url: request.url, status: 204, statusText: "No Content", detail: "HTTP 204 No Content for JSON response" })`.
- Map JSON decoding errors to `HttpNetworkError`.
Update `fetchText`:
- Map text reading errors to `HttpNetworkError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/utils/HttpClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/HttpClient.ts test/utils/HttpClient.test.ts
git commit -m "http: define fine-grained HTTP tagged errors

### Problem

All HTTP errors were conflated into a single \`HttpFetchError\` class,
preventing caller pattern matching with Effect's \`catchTag\` and obscuring
error taxonomy between client errors, server errors, timeouts, and network faults.

### Solution

Replace monolithic \`HttpFetchError\` with a discriminated union of typed
\`Schema.TaggedError\` classes: \`HttpNotFoundError\`, \`HttpNoContentError\`,
\`HttpRateLimitError\`, \`HttpClientStatusError\`, \`HttpServerStatusError\`,
\`HttpTimeoutError\`, and \`HttpNetworkError\`. Automatically classify response
statuses and timeout failures in \`executeWithResponse\`, \`fetchJson\`, and \`fetchText\`.

### References

.superpowers/specs/2026-11-09-http-tagged-errors-design.md"
```

---

### Task 2: Migrate `DanbooruClient` to Fine-Grained Tagged Errors

**Files:**
- Modify: `src/features/danbooru/DanbooruClient.ts`
- Test: `test/features/danbooru/DanbooruClient.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `executeWithResponse`, `HttpNotFoundError`, `HttpNoContentError`, `HttpRateLimitError`, `HttpClientStatusError`, `HttpServerStatusError`, `HttpTimeoutError`, `HttpNetworkError` from `../../utils/HttpClient.ts`
- Produces: `DanbooruClient` methods `getRandomPost` and `downloadImage` using idiomatic `Effect.catchTags`

- [ ] **Step 1: Update unit tests in `test/features/danbooru/DanbooruClient.test.ts`**

Ensure test cases explicitly cover:
- 204 No Content -> fails with `DanbooruNotFoundError`
- 404 Not Found -> fails with `DanbooruNotFoundError`
- 429 Rate Limit -> fails with `DanbooruRateLimitError`
- 500 Server Error -> fails with `DanbooruApiError` (with `status: 500`)

- [ ] **Step 2: Run test to verify it passes or fails**

Run: `bun test test/features/danbooru/DanbooruClient.test.ts`

- [ ] **Step 3: Refactor `DanbooruClient.ts` to use `fetchJson` and `Effect.catchTags`**

In `getRandomPost`:
- Replace custom `executeWithResponse` with `fetchJson(request, DanbooruPostSchema, { timeoutDuration: "10 seconds" })`.
- Replace manual `Effect.mapError` checking `error._tag === "HttpFetchError"` with:
  ```ts
  Effect.catchTags({
    HttpNotFoundError: () => new DanbooruNotFoundError({ queryTags }),
    HttpNoContentError: () => new DanbooruNotFoundError({ queryTags }),
    HttpRateLimitError: () => new DanbooruRateLimitError(),
    HttpClientStatusError: (err) =>
      new DanbooruApiError({ status: err.status, message: err.message }),
    HttpServerStatusError: (err) =>
      new DanbooruApiError({ status: err.status, message: err.message }),
    HttpTimeoutError: (err) =>
      new DanbooruApiError({ status: 0, message: err.message }),
    HttpNetworkError: (err) =>
      new DanbooruApiError({ status: err.status ?? 0, message: err.message }),
  })
  ```
In `downloadImage`:
- Map errors using `err.status ?? 0` to preserve status on `DanbooruApiError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/danbooru/DanbooruClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/danbooru/DanbooruClient.ts test/features/danbooru/DanbooruClient.test.ts
git commit -m "danbooru: use HTTP tagged errors in DanbooruClient

### Problem

\`DanbooruClient.getRandomPost\` had to manually unpack \`HttpFetchError\`
and inspect \`status === 404\` and \`status === 429\`, and circumvented
\`fetchJson\` by writing custom \`executeWithResponse\` callbacks to detect
HTTP 204 before JSON parsing failed.

### Solution

Switch \`getRandomPost\` to use \`fetchJson\` directly and handle HTTP failures
declaratively with \`Effect.catchTags\` targeting \`HttpNotFoundError\`,
\`HttpNoContentError\`, \`HttpRateLimitError\`, and status family errors.

### References

.superpowers/specs/2026-11-09-http-tagged-errors-design.md"
```

---

### Task 3: Migrate `LinkPreviewSites.ts` & `LinkPreview.ts`

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts`
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewSites.test.ts`
- Test: `test/features/link-preview/LinkPreviewEngine.test.ts`
- Test: `test/features/link-preview/LinkPreviewFormat.test.ts`
- Test: `test/features/link-preview/DecisionFilter.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `HttpNotFoundError`, `HttpFetchError` from `../../utils/HttpClient.ts`
- Produces: Cleaned-up `danbooruCustomizer.scrape` without dead code, using `Effect.catchTag("HttpNotFoundError")` for 404 propagation and fallback on other HTTP errors. Re-exported `HttpFetchError` type in `LinkPreview.ts`.

- [ ] **Step 1: Update unit tests in `test/features/link-preview/`**

- In `LinkPreviewSites.test.ts`: verify 404 fails with `HttpNotFoundError`.
- In `LinkPreviewEngine.test.ts`: replace `toBeInstanceOf(HttpFetchError)` with specific error checks (`toBeInstanceOf(HttpNotFoundError)` for 404, `toBeInstanceOf(HttpServerStatusError)` for 500, `toBeInstanceOf(HttpTimeoutError)` for timeouts).
- In `LinkPreviewFormat.test.ts`: update imports/constructors to use `HttpNotFoundError` for 404 and `HttpTimeoutError` for timeout where `new HttpFetchError` was constructed.
- In `DecisionFilter.test.ts`: update test fixtures to use `new HttpNotFoundError` instead of `new HttpFetchError`.

- [ ] **Step 2: Run tests to verify failure/mismatches**

Run: `bun test test/features/link-preview/`

- [ ] **Step 3: Refactor `LinkPreviewSites.ts` and `LinkPreview.ts`**

In `src/features/link-preview/LinkPreviewSites.ts`:
- In `danbooruCustomizer`:
  - Remove dead code inside `executeWithResponse` checking `if (response.status === 404)` and `if (response.status !== 200)`.
  - Use `fetchJson(request, DanbooruPostSchema, { timeoutDuration })`.
  - In error handler:
    ```ts
    Effect.catchTag("HttpNotFoundError", (err) => Effect.fail(err)),
    Effect.catchTags({
      HttpNoContentError: () => Effect.succeed(undefined as PageMetadata | undefined),
      HttpClientStatusError: () => Effect.succeed(undefined as PageMetadata | undefined),
      HttpServerStatusError: () => Effect.succeed(undefined as PageMetadata | undefined),
      HttpTimeoutError: () => Effect.succeed(undefined as PageMetadata | undefined),
      HttpNetworkError: () => Effect.succeed(undefined as PageMetadata | undefined),
    })
    ```
In `src/features/link-preview/LinkPreview.ts`:
- Re-export `type { HttpFetchError }` from `../../utils/HttpClient.ts` alongside any specific error classes if needed.
- In `downloadSingleImage`: catch `HttpFetchError` tags cleanly to format log warnings.

- [ ] **Step 4: Run tests to verify all link-preview tests pass**

Run: `bun test test/features/link-preview/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/ test/features/link-preview/
git commit -m "link-preview: use HttpNotFoundError and remove dead code

### Problem

\`LinkPreviewSites.ts\` contained unreachable dead code checking \`response.status === 404\`
inside \`executeWithResponse\`, while \`LinkPreviewEngine.test.ts\` and \`LinkPreviewFormat.test.ts\`
were coupled to the monolithic \`HttpFetchError\` class.

### Solution

Remove dead status checks in \`danbooruCustomizer\`, switch to \`fetchJson\`,
and use \`Effect.catchTag(\"HttpNotFoundError\")\` to propagate 404 errors while
falling back on other status codes. Update link preview test fixtures and
assertions to use specific Tagged Errors.

### References

.superpowers/specs/2026-11-09-http-tagged-errors-design.md"
```

---

### Task 4: Full Repository Verification & Knip Cleanliness

**Files:**
- Modify any files requiring final type/lint/export fixes.

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: 100% tests pass.

- [ ] **Step 2: Run type check**

Run: `bun run check`
Expected: 0 errors (`tsc --noEmit`).

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: 0 warnings and 0 errors (`oxlint`).

- [ ] **Step 4: Run unused exports check**

Run: `bun run knip`
Expected: 0 unused exports / dependencies.

- [ ] **Step 5: Commit (if any adjustments were made)**

```bash
git commit -m "chore: align repository verification and linting"
```
