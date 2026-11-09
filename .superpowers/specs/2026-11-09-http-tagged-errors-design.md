# HTTP Tagged Errors Design

## Intent & The Why

Currently, all HTTP failures in `src/utils/HttpClient.ts` are represented by a single monolithic `HttpFetchError` class carrying optional `status`, `statusText`, and `detail` fields.

When callers require different behaviors depending on HTTP status codes, they cannot leverage Effect's native pattern matching (`Effect.catchTag` / `Effect.catchTags`). Instead, they must catch `HttpFetchError` and procedurally inspect `error.status`:
1. `DanbooruClient.ts`: Manually matches `error.status === 404` to `DanbooruNotFoundError`, `error.status === 429` to `DanbooruRateLimitError`, and falls back to `DanbooruApiError`. It also manually handles `204 No Content` inside `executeWithResponse` because `fetchJson` would fail decoding an empty body.
2. `LinkPreviewSites.ts`: Contains dead code checking `response.status === 404` inside `executeWithResponse` (where non-2xx statuses are already rejected), followed by an outer `Effect.catchTag("HttpFetchError")` inspecting `err.status === 404` to differentiate unrecoverable errors from fallback-eligible failures.
3. `LinkPreview.ts`, `SauceNao.ts`, `DecisionFilter.ts`: Format error details using ternary checks on `error.status !== undefined`.

Refining `HttpFetchError` into a discriminated union of typed `Schema.TaggedError` classes eliminates manual status inspection, removes dead code, enables idiomatic `Effect.catchTags`, and preserves type-safe error channels across the codebase.

---

## Goals, Non-Goals & Anti-Goals

### Goals
1. **Refined Tagged Errors**: Define granular `Schema.TaggedError` classes in `src/utils/HttpClient.ts`:
   - `HttpNotFoundError`: Status 404.
   - `HttpNoContentError`: Status 204 (for empty body responses in JSON/data contexts).
   - `HttpRateLimitError`: Status 429.
   - `HttpClientStatusError`: Other 4xx status codes (retaining numeric `status`).
   - `HttpServerStatusError`: 5xx status codes (retaining numeric `status`).
   - `HttpTimeoutError`: Request or response stream timeouts.
   - `HttpNetworkError`: Network failures, connection aborts, DNS lookup failures, or response body decoding failures.
2. **Discriminated Union Export**: Export `HttpFetchError` as a union type:
   ```ts
   export type HttpFetchError =
     | HttpNotFoundError
     | HttpNoContentError
     | HttpRateLimitError
     | HttpClientStatusError
     | HttpServerStatusError
     | HttpTimeoutError
     | HttpNetworkError;
   ```
3. **Automatic Status Classification**: Update `executeWithResponse` and `fetchJson` to construct the exact Tagged Error based on response status or failure cause.
4. **Clean Call-Site Adoption**:
   - Refactor `DanbooruClient.ts` to use `Effect.catchTags` with `HttpNotFoundError`, `HttpNoContentError`, and `HttpRateLimitError`.
   - Clean up redundant response checks in `LinkPreviewSites.ts` and use `Effect.catchTag("HttpNotFoundError")`.
5. **Full Test & Lint Compliance**: Update existing unit tests to assert specific Tagged Errors and ensure 0 type or lint errors.

### Non-Goals
1. Wrapping or rewriting `HttpClientRequest` builders (`HttpClientRequest.get`, `HttpClientRequest.setHeader`).
2. Redefining domain-specific error classes (`DanbooruNotFoundError`, `DanbooruRateLimitError`, `BlockedHostError`).
3. Modifying SSRF guards or Metascraper parsing rules.

### Anti-Goals
1. Creating dozens of individual error classes for rare HTTP codes (e.g. 402, 405, 418) that share identical fallback semantics.
2. Dropping `{ readonly brand: unique symbol }` required by `@effect/tsgo`.
3. Breaking backwards compatibility where callers consume general error messages.

---

## Approaches Considered

### Approach 1: High-Frequency Semantic Errors + Status Family Fallbacks (Chosen)
- Provide dedicated Tagged Errors for 404, 204, 429, and timeouts, while grouping other statuses into `HttpClientStatusError` (4xx), `HttpServerStatusError` (5xx), and `HttpNetworkError`.
- **Trade-offs**: Perfectly aligns with the actual branching needs of callers; enables idiomatic Effect `catchTag` without proliferation of unnecessary classes.

### Approach 2: Pure Status Code Ranges (4xx / 5xx / Timeout / Network)
- Only define `HttpClientStatusError`, `HttpServerStatusError`, `HttpTimeoutError`, and `HttpNetworkError`.
- **Trade-offs**: Minimal class count, but callers still have to write `if (err.status === 404)` inside `catchTag("HttpClientStatusError")`, failing to solve the core ergonomic friction.

### Approach 3: Exhaustive RFC Status Code Enumeration
- Define separate Tagged Errors for every HTTP status code (400, 401, 403, 404, 429, 500, 502, 503, 504, etc.).
- **Trade-offs**: Excessive boilerplate and maintenance overhead with no practical gain for unused status codes.

---

## Detailed Design

### 1. Error Definitions in `src/utils/HttpClient.ts`

Every error inherits from `Schema.TaggedError` with branded symbols:

```ts
export class HttpNotFoundError extends Schema.TaggedError<
  HttpNotFoundError,
  { readonly brand: unique symbol }
>()("HttpNotFoundError", {
  url: Schema.String,
  status: Schema.Literal(404),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 404${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpNoContentError extends Schema.TaggedError<
  HttpNoContentError,
  { readonly brand: unique symbol }
>()("HttpNoContentError", {
  url: Schema.String,
  status: Schema.Literal(204),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 204${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpRateLimitError extends Schema.TaggedError<
  HttpRateLimitError,
  { readonly brand: unique symbol }
>()("HttpRateLimitError", {
  url: Schema.String,
  status: Schema.Literal(429),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 429${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpClientStatusError extends Schema.TaggedError<
  HttpClientStatusError,
  { readonly brand: unique symbol }
>()("HttpClientStatusError", {
  url: Schema.String,
  status: Schema.Finite,
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpServerStatusError extends Schema.TaggedError<
  HttpServerStatusError,
  { readonly brand: unique symbol }
>()("HttpServerStatusError", {
  url: Schema.String,
  status: Schema.Finite,
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpTimeoutError extends Schema.TaggedError<
  HttpTimeoutError,
  { readonly brand: unique symbol }
>()("HttpTimeoutError", {
  url: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class HttpNetworkError extends Schema.TaggedError<
  HttpNetworkError,
  { readonly brand: unique symbol }
>()("HttpNetworkError", {
  url: Schema.String,
  status: Schema.optional(Schema.Finite),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export type HttpFetchError =
  | HttpNotFoundError
  | HttpNoContentError
  | HttpRateLimitError
  | HttpClientStatusError
  | HttpServerStatusError
  | HttpTimeoutError
  | HttpNetworkError;
```

### 2. Status Classification in `executeWithResponse`

In `executeWithResponse`:
1. Connection/execution error from `client.execute`:
   ```ts
   Effect.mapError((error) => new HttpNetworkError({ url, detail: error.message }))
   ```
2. Non-2xx check (`response.status < 200 || response.status >= 300`):
   ```ts
   const webRes = Option.getOrUndefined(HttpClientResponse.toWeb(response));
   cancelResponse(response);
   const status = response.status;
   const statusText = webRes?.statusText;
   const detail = `HTTP status ${status}`;

   if (status === 404) {
     return yield* new HttpNotFoundError({ url, status: 404, statusText, detail });
   }
   if (status === 429) {
     return yield* new HttpRateLimitError({ url, status: 429, statusText, detail });
   }
   if (status >= 500) {
     return yield* new HttpServerStatusError({ url, status, statusText, detail });
   }
   return yield* new HttpClientStatusError({ url, status, statusText, detail });
   ```
3. Timeout error mapping:
   ```ts
   if (Cause.isTimeoutError(error)) {
     return new HttpTimeoutError({
       url,
       detail: `Request timed out after ${timeoutStr}`,
     });
   }
   ```

### 3. Special Status Handling in `fetchJson` & `fetchText`

1. `fetchJson`:
   - If `response.status === 204`:
     ```ts
     if (response.status === 204) {
       cancelResponse(response);
       return yield* new HttpNoContentError({
         url: request.url,
         status: 204,
         statusText: "No Content",
         detail: "HTTP 204 No Content for JSON response",
       });
     }
     ```
   - JSON decoding error:
     ```ts
     new HttpNetworkError({
       url: request.url,
       status: response.status,
       detail: `Failed to parse response JSON: ${String(error)}`,
     })
     ```
2. `fetchText`:
   - Text read failure:
     ```ts
     new HttpNetworkError({
       url: request.url,
       detail: `Failed to read response text: ${error.message}`,
     })
     ```

### 4. Call Site Migrations

1. **`src/features/danbooru/DanbooruClient.ts`**:
   - `getRandomPost` can now invoke `fetchJson(request, DanbooruPostSchema)` directly!
   - Replace manual `Effect.mapError` with `Effect.catchTags`:
     ```ts
     Effect.catchTags({
       HttpNotFoundError: () => new DanbooruNotFoundError({ queryTags }),
       HttpNoContentError: () => new DanbooruNotFoundError({ queryTags }),
       HttpRateLimitError: () => new DanbooruRateLimitError(),
       HttpClientStatusError: (err) => new DanbooruApiError({ status: err.status, message: err.message }),
       HttpServerStatusError: (err) => new DanbooruApiError({ status: err.status, message: err.message }),
       HttpTimeoutError: (err) => new DanbooruApiError({ status: 0, message: err.message }),
       HttpNetworkError: (err) => new DanbooruApiError({ status: err.status ?? 0, message: err.message }),
     })
     ```
   - `downloadImage` can catch `HttpFetchError` or map its `status` cleanly.
2. **`src/features/link-preview/LinkPreviewSites.ts`**:
   - `danbooruCustomizer`:
     - Delete redundant dead code (`if (response.status === 404) ... if (response.status !== 200) ...`).
     - Directly use `fetchJson(request, DanbooruPostSchema)`.
     - In outer pipeline:
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
3. **`src/features/link-preview/LinkPreview.ts`**:
   - Re-export `HttpFetchError` (type) and individual error classes as needed.
   - Update `ScrapeMetadataError` type union to include `HttpFetchError`.

---

## What's Left to the Builder

1. Implement all Tagged Error classes in `src/utils/HttpClient.ts` with branded symbols and test them.
2. Update `executeWithResponse`, `fetchText`, and `fetchJson` implementations.
3. Migrate `DanbooruClient.ts` and `LinkPreviewSites.ts`.
4. Update unit test assertions in `test/utils/HttpClient.test.ts`, `test/features/danbooru/DanbooruClient.test.ts`, `test/features/link-preview/LinkPreviewEngine.test.ts`, `test/features/link-preview/LinkPreviewFormat.test.ts`, and `test/features/link-preview/LinkPreviewSites.test.ts`.
5. Run full verification: `bun test`, `bun run check`, `bun run lint`.
