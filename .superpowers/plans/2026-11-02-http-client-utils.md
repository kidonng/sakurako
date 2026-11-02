# Unified HTTP Execution Utilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a centralized HTTP request execution utility in `src/utils/HttpClient.ts` with automatic default UA, 2xx validation, stream body cancellation, unified timeout wrapping, and unified `HttpFetchError`, and migrate all existing call sites (`LinkPreview`, `JevFilter`, `SauceNao`).

**Architecture:** Encapsulate the full request-response-body lifecycle in `executeWithResponse` using `HttpClient.HttpClient` from the Effect environment. Provide `fetchText` and `fetchJson` convenience helpers, a safe `cancelResponse` stream cleanup utility, and a unified `HttpFetchError`. Migrate all 4 callers and ensure complete backward compatibility.

**Tech Stack:** TypeScript, Bun, Effect 4 (`effect`, `effect/http`, `effect/schema`), `bun:test`.

**Spec:** `.superpowers/specs/2026-11-02-http-client-utils-design.md`

## Global Constraints

- Pinned Bun runtime (`1.4.4`).
- Strict TypeScript (`verbatimModuleSyntax: true`, `.ts` extensions in local relative imports).
- Schema.TaggedError definitions MUST include `{ readonly brand: unique symbol }` as second type parameter.
- No `any` or `as any`.
- Effect generator syntax (`Effect.fnUntraced`, `Effect.gen`).
- Timeout MUST wrap both header retrieval and response body consumption.

## Review Focus

1. **Non-2xx response status:** Ensure `HttpFetchError` retains exact numeric `status`, `statusText`, and that the unread body stream is safely canceled.
2. **Response body stall / timeout:** Ensure stalling streams trigger timeout and fail with `HttpFetchError` without hanging.
3. **Safe stream cancellation on already-read responses:** Ensure `cancelResponse` does not throw `TypeError: Invalid state: ReadableStream is locked` when body has already been consumed.
4. **Automatic User-Agent header attachment:** Ensure requests without `User-Agent` receive `"Sakurako/1.0"`, while requests with explicit `User-Agent` preserve their custom value.
5. **Schema decoding error mapping:** Ensure `fetchJson` returns `HttpFetchError` with descriptive message when response body is not valid JSON or fails schema parsing.

---

### Task 1: Core HTTP Utility Module & Tests

**Files:**
- Create: `src/utils/HttpClient.ts`
- Create: `test/utils/HttpClient.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_USER_AGENT: "Sakurako/1.0";

  export class HttpFetchError extends Schema.TaggedError<
    HttpFetchError,
    { readonly brand: unique symbol }
  >()("HttpFetchError", {
    url: Schema.String,
    status: Schema.optional(Schema.Finite),
    statusText: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }) {}

  export function cancelResponse(
    response: HttpClientResponse.HttpClientResponse,
  ): void;

  export interface RequestExecutionOptions {
    readonly timeoutDuration?: Duration.Input;
  }

  export const executeWithResponse: <A, E, R>(
    request: HttpClientRequest.HttpClientRequest,
    onResponse: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
    options?: RequestExecutionOptions,
  ) => Effect.Effect<A, E | HttpFetchError, R | HttpClient.HttpClient>;

  export const fetchText: (
    request: HttpClientRequest.HttpClientRequest,
    options?: RequestExecutionOptions,
  ) => Effect.Effect<{ readonly text: string; readonly url: string }, HttpFetchError, HttpClient.HttpClient>;

  export const fetchJson: <A, I, R>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Schema<A, I, R>,
    options?: RequestExecutionOptions,
  ) => Effect.Effect<A, HttpFetchError, R | HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write the failing unit tests for `src/utils/HttpClient.ts`**

In `test/utils/HttpClient.test.ts`, write tests using `makeTestHttpClient` from `../TestHttpClient.ts`:
- `fetchText` returns text and URL on 200 OK.
- Automatically adds `User-Agent: Sakurako/1.0` if request has no UA.
- Preserves custom `User-Agent` if explicitly provided.
- Fails with `HttpFetchError` on non-2xx (e.g. 404, 500) and cancels unread body.
- Fails with `HttpFetchError` on timeout when stream stalls.
- `fetchJson` decodes valid payload and fails with `HttpFetchError` on invalid JSON or schema mismatch.
- `cancelResponse` does not throw when stream was already consumed.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/utils/HttpClient.test.ts`
Expected: FAIL (module `src/utils/HttpClient.ts` does not exist yet)

- [ ] **Step 3: Implement `src/utils/HttpClient.ts`**

Implement `DEFAULT_USER_AGENT`, `HttpFetchError`, `cancelResponse`, `executeWithResponse`, `fetchText`, and `fetchJson`:
- In `executeWithResponse`, check `request.headers["user-agent"]`. If unset, set to `DEFAULT_USER_AGENT`.
- Safely call `cancelResponse` on non-2xx status, and via `Effect.onError` if `onResponse` fails.
- Wrap execution and body reading with `Effect.timeout(timeoutDuration)`.
- In `fetchJson`, use `HttpClientResponse.schemaBodyJson(schema)(response)` and map errors to `HttpFetchError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/utils/HttpClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/HttpClient.ts test/utils/HttpClient.test.ts
git commit -m "feat(http): add unified HTTP execution utilities and tests"
```

---

### Task 2: Migrate LinkPreview (`scrapeMetadata` and `prepareOutgoingImage`)

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts:14-20` (import and re-export `DEFAULT_USER_AGENT` from `../../utils/HttpClient.ts`)
- Modify: `src/features/link-preview/LinkPreview.ts` (re-export `HttpFetchError` from `../../utils/HttpClient.ts`, refactor `scrapeMetadata` and `prepareOutgoingImage`)
- Test: `test/features/link-preview/LinkPreviewEngine.test.ts`

**Interfaces:**
- Consumes: `executeWithResponse`, `fetchText`, `cancelResponse`, `HttpFetchError` from `../../utils/HttpClient.ts`
- Produces: `scrapeMetadata` returning `Effect.Effect<PageMetadata, ScrapeMetadataError, HttpClient.HttpClient>`, `prepareOutgoingImage` returning `Effect.Effect<string | undefined, never, HttpClient.HttpClient>`, `HttpFetchError` re-exported.

- [ ] **Step 1: Update `LinkPreviewSites.ts`**

Re-export `DEFAULT_USER_AGENT` from `../../utils/HttpClient.ts` instead of defining a duplicate literal string.

- [ ] **Step 2: Update `LinkPreview.ts`**

- Remove local `HttpFetchError` class definition and instead `export { HttpFetchError } from "../../utils/HttpClient.ts"`.
- In `scrapeMetadata`:
  - Build `request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)), HttpClientRequest.setHeader("Accept", DEFAULT_ACCEPT_HEADER))`.
  - Replace manual `client.execute` / status check / cancel / timeout with `fetchText(request, { timeoutDuration })`.
  - Pass `{ html: text, url: targetUrl }` to `scraper`.
- In `prepareOutgoingImage`:
  - Build `request = HttpClientRequest.get(imageUrl).pipe(HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)))`.
  - Replace manual download block with `executeWithResponse(request, (response) => Effect.gen(...), { timeoutDuration })`.
  - In `onResponse`: inspect `Content-Type` and `Content-Length`. If invalid, call `cancelResponse(response)` and return `undefined`. Otherwise, `yield* response.arrayBuffer`.
  - Catch `HttpFetchError` and log warning instead of `FetchImageError`.

- [ ] **Step 3: Run LinkPreview tests to verify they pass**

Run: `bun test test/features/link-preview/LinkPreviewEngine.test.ts test/features/link-preview/LinkPreviewBot.test.ts test/features/link-preview/LinkPreviewSites.test.ts test/features/link-preview/LinkPreviewFormat.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts src/features/link-preview/LinkPreviewSites.ts
git commit -m "refactor(link-preview): use unified HTTP client utilities"
```

---

### Task 3: Migrate JevFilter and SauceNao

**Files:**
- Modify: `src/features/link-preview/JevFilter.ts:160-210`
- Modify: `src/features/sauce/SauceNao.ts:145-195`
- Test: `test/features/link-preview/JevFilter.test.ts`
- Test: `test/features/sauce/SauceNao.test.ts`
- Test: `test/features/sauce/SauceBot.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `HttpFetchError` from `../../utils/HttpClient.ts`
- Produces: `filterLinkPreviews` and `searchSauce` using `fetchJson`.

- [ ] **Step 1: Refactor `src/features/link-preview/JevFilter.ts`**

- Replace manual `client.execute` / status check / cancel / `schemaBodyJson` / timeout in `filterLinkPreviews` with:
  ```ts
  const responseData = yield* fetchJson(request, SystemOneResponseSchema, {
    timeoutDuration,
  });
  ```
- Catch `HttpFetchError` alongside existing errors to log warning and fall back to original URLs.

- [ ] **Step 2: Refactor `src/features/sauce/SauceNao.ts`**

- Replace manual `client.execute` / status check / cancel / `schemaBodyJson` / timeout in `searchSauce` with:
  ```ts
  const json = yield* fetchJson(request, SauceNaoResponseSchema, {
    timeoutDuration,
  }).pipe(
    Effect.mapError((error) => new SauceNaoError({ cause: error.message })),
  );
  ```
- Note: This automatically fixes the previous unread body stream leak on non-2xx responses in SauceNao.

- [ ] **Step 3: Run JevFilter and Sauce tests to verify they pass**

Run: `bun test test/features/link-preview/JevFilter.test.ts test/features/sauce/SauceNao.test.ts test/features/sauce/SauceBot.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/link-preview/JevFilter.ts src/features/sauce/SauceNao.ts
git commit -m "refactor(sauce,jev): migrate to unified fetchJson"
```

---

### Task 4: Full Suite Verification & Code Standards

**Files:**
- Check: Entire codebase

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Run type checking**

Run: `bun run check`
Expected: 0 errors.

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Run knip check**

Run: `bun run knip`
Expected: No unused exports or missing dependencies.

- [ ] **Step 5: Run formatting check**

Run: `bun run format`
Expected: Clean formatting.

- [ ] **Step 6: Commit any formatting or minor cleanups if needed**

```bash
git commit -am "chore: format and clean up after HTTP utilities migration"
```
