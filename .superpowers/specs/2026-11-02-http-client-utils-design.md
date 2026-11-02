# Unified HTTP Execution Utilities Design

## Intent & Why

Currently, HTTP requests across the codebase (`LinkPreview.scrapeMetadata`, `LinkPreview.prepareOutgoingImage`, `JevFilter.filterLinkPreviews`, and `SauceNao.searchSauce`) duplicate the entire request execution lifecycle:
- Extracting `client = yield* HttpClient.HttpClient`
- Executing `client.execute(request)`
- Checking `response.status < 200 || response.status >= 300`
- Canceling unconsumed response body streams (`toWeb(response)?.body?.cancel()`) to prevent resource leaks
- Wrapping execution and body reads with `Effect.timeout`
- Wrapping HTTP failure status/timeouts in separate domain error wrappers (`HttpFetchError`, `FetchImageError`, `JevFilterError`, `SauceNaoError`)

This duplication is noisy, repetitive, and error-prone (e.g. `SauceNao.ts` previously omitted stream cancellation on non-2xx responses).

Consolidating the execution lifecycle and error reporting into a unified utility module eliminates repetitive boilerplate, standardizes timeout and stream safety guarantees, and simplifies call sites.

## Goals, Non-Goals & Anti-Goals

### Goals
- Introduce a centralized utility module (`src/utils/HttpClient.ts`) for executing HTTP requests with full lifecycle management.
- Provide `executeWithResponse(request, onResponse, options?)` as the core primitive, and convenience helpers `fetchText(request, options?)` and `fetchJson(request, schema, options?)`.
- Standardize on a unified tagged error `HttpFetchError` (with `url`, `status`, `statusText`, `detail`) across all HTTP operations, eliminating redundant per-module error wrappers for basic HTTP status failures.
- Guarantee that unconsumed or failed response bodies are safely canceled (`cancel()`), preventing stream leaks.
- Ensure that timeout constraints wrap both request dispatch and response body consumption.
- Refactor all 4 HTTP call sites to use the new utility without breaking any existing test contracts.
- Automatically supply `User-Agent: DEFAULT_USER_AGENT` ("Sakurako/1.0") if not already specified on the request.

### Non-Goals
- Do not replace or wrap `HttpClientRequest` builder functions (`HttpClientRequest.get`, `HttpClientRequest.post`, `HttpClientRequest.setHeader`, etc.).
- Do not modify site-specific headers, scraping logic, or domain formatting.

### Anti-Goals
- Do not implement custom `HttpClient` middleware layers that complicate testing with `TestHttpClient`.
- Do not drop timeout protection from body consumption.

## Approaches Considered

1. **High-Level Executor + Convenience Helpers with Unified Error (Selected)**
   - Core function `executeWithResponse(request, onResponse, options?)` manages execution, 2xx validation, stream cleanup, and end-to-end timeout.
   - Convenience helpers `fetchText` and `fetchJson` cover common cases.
   - Reuses a unified `HttpFetchError` for all HTTP failures.
   - *Trade-offs*: Highly cohesive, eliminates boilerplate completely, zero stream leaks, simple to consume.

2. **Fine-Grained Helpers (`executeOk` + `cancelBody`)**
   - Provide small separate functions: `executeOk` to check 2xx status and `cancelBody` to clean up streams.
   - Callers still write custom `Effect.gen` and manage `Effect.timeout` around body reads.
   - *Trade-offs*: Less invasive, but leaves timeout and manual cancel coordination in every caller, defeating the goal of eliminating execution boilerplate.

3. **Effect Client Middleware (`HttpClient.filterStatusOk` wrapper)**
   - Provide a modified `HttpClient` via Effect layer/pipe.
   - *Trade-offs*: Interceptors only observe up to response header receipt and cannot reliably enforce timeouts across downstream body reading; conflicts with test layering.

## Decided Design

### 1. Unified Error Model
`HttpFetchError` is moved to `src/utils/HttpClient.ts` and re-exported from `src/features/link-preview/LinkPreview.ts` for backward compatibility:
```ts
export class HttpFetchError extends Schema.TaggedError<
  HttpFetchError,
  {
    readonly brand: unique symbol;
  }
>()("HttpFetchError", {
  url: Schema.String,
  status: Schema.optional(Schema.Finite),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const parts: string[] = [];
    if (this.status !== undefined) {
      parts.push(`HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`);
    }
    if (this.detail) {
      parts.push(this.detail);
    }
    return `Failed to fetch ${this.url}: ${parts.join(" - ") || "Unknown error"}`;
  }
}
```

### 2. Stream Cancellation Helper
Safely cancels unconsumed response streams without throwing if the stream is already locked/consumed:
```ts
export function cancelResponse(
  response: HttpClientResponse.HttpClientResponse,
): void {
  const webRes = Option.getOrUndefined(HttpClientResponse.toWeb(response));
  if (webRes && !webRes.bodyUsed && webRes.body && !webRes.body.locked) {
    void webRes.body.cancel().catch(() => {});
  }
}
```
### 3. Default User-Agent
```ts
export const DEFAULT_USER_AGENT = "Sakurako/1.0";
```
If the outgoing request does not already contain a `User-Agent` header (`request.headers["user-agent"] === undefined`), `executeWithResponse` automatically attaches `User-Agent: DEFAULT_USER_AGENT`.

### 4. Core Execution Lifecycle: `executeWithResponse`
```ts
export interface RequestExecutionOptions {
  readonly timeoutDuration?: Duration.Input;
}

export const executeWithResponse = Effect.fnUntraced(function* <A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  onResponse: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
  options?: RequestExecutionOptions,
): Effect.Effect<A, E | HttpFetchError, R | HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const timeoutDuration = options?.timeoutDuration ?? "10 seconds";
  const url = request.url || "";

  const finalRequest = request.headers["user-agent"]
    ? request
    : HttpClientRequest.setHeader(request, "User-Agent", DEFAULT_USER_AGENT);

  const run = Effect.gen(function* () {
    const response = yield* client.execute(finalRequest).pipe(
      Effect.mapError(
        (error) =>
          new HttpFetchError({
            url,
            detail: error.message,
          }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const webRes = Option.getOrUndefined(HttpClientResponse.toWeb(response));
      cancelResponse(response);
      return yield* new HttpFetchError({
        url,
        status: response.status,
        statusText: webRes?.statusText,
        detail: `HTTP status ${response.status}`,
      });
    }

    return yield* onResponse(response).pipe(
      Effect.onError(() => Effect.sync(() => cancelResponse(response))),
    );
  });

  return yield* run.pipe(
    Effect.timeout(timeoutDuration),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "TimeoutException")
        ? new HttpFetchError({
            url,
            detail: `Request timed out after ${Duration.format(timeoutDuration)}`,
          })
        : error,
    ),
  );
});
```

### 5. Convenience Helpers
- `fetchText(request, options?)`:
  Returns `{ text: string; url: string }` where `url` is `response.url || request.url`.
- `fetchJson(request, schema, options?)`:
  Runs `HttpClientResponse.schemaBodyJson(schema)(response)` and maps decoding errors to `HttpFetchError`.

### 6. Call Site Migration
- `LinkPreview.scrapeMetadata`: Replaced with `fetchText(request, { timeoutDuration })`.
- `LinkPreview.prepareOutgoingImage`: Replaced with `executeWithResponse(request, (response) => ...)`. Non-image / oversized checks call `cancelResponse(response)` and return `undefined`.
- `JevFilter.filterLinkPreviews`: Replaced with `fetchJson(request, SystemOneResponseSchema, { timeoutDuration })`. Catches `HttpFetchError` and logs warning.
- `SauceNao.searchSauce`: Replaced with `fetchJson(request, SauceNaoResponseSchema, { timeoutDuration })`. Catches `HttpFetchError` and logs warning.

## What's Left to Builder
- Implement `src/utils/HttpClient.ts` with complete type definitions and oxlint/effecttsgo compliance.
- Update all 4 call sites and re-export `HttpFetchError` from `LinkPreview.ts`.
- Run `bun test`, `bun run check`, `bun run lint` to verify zero regression.
