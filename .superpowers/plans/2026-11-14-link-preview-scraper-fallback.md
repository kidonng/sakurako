# Link Preview Scraper Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an engine-agnostic scraping fallback service to `LinkPreview` that recovers from local HTTP blocks (401/403/429/5xx), timeouts, and network errors by falling back to remote scraping engines starting with Firecrawl `/v2/scrape`.

**Architecture:** `src/features/link-preview/FallbackScraper.ts` defines a generic `FallbackScraper` Effect service (`Context.Service`) backed by an ordered `ReadonlyArray<ScraperEngine>` and bounded by a concurrency semaphore (`2`). `scrapeMetadata` in `src/features/link-preview/LinkPreview.ts` runs SSRF checks and local `fetchText` first, and on recoverable fetch errors invokes `Effect.serviceOption(FallbackScraper)`, feeding returned `rawHtml` back through the existing `metascraper` pipeline (with structured `metadata` fallback) while preserving the original local error if all fallback engines fail.

**Tech Stack:** Bun 1.4.4, TypeScript 7 (`noEmit`), Effect 4 (`effect`, `effect/http`), `Schema`, `Semaphore`, `bun:test`, `oxlint`, `knip`.

**Spec:** `.superpowers/specs/2026-11-14-link-preview-scraper-fallback-design.md`

## Global Constraints

- Feature/service/module names MUST NOT be named "Firecrawl" (`FallbackScraper`, `ScraperEngine`, `FallbackScrapeResult`, `FallbackScrapeError`); `"firecrawl"` is only the internal `engine.id` and `FIRECRAWL_API_KEY` env var.
- SSRF `isPrivateHost` MUST execute before any remote fallback; private/local URLs MUST NEVER be sent to external engines.
- `404` (`HttpNotFoundError`), `204` (`HttpNoContentError`), `InvalidUrlError`, `BlockedHostError`, and `ParseMetadataError` MUST NOT trigger fallback.
- Firecrawl `/v2/scrape` request MUST use `formats: ["rawHtml"]`, `timeout: 25000` (ms), and Effect HTTP `timeoutDuration: "30 seconds"`, without API key required (adding `Authorization: Bearer` only when `FIRECRAWL_API_KEY` is configured).
- Firecrawl response validation MUST treat `success !== true`, missing `data`, non-2xx `data.metadata.statusCode`, or empty `rawHtml` + empty `metadata` as failures.
- Concurrency of fallback scrapes MUST be bounded (`Semaphore.makeUnsafe(2)`) to avoid hitting Firecrawl's 2-concurrent-browser limit during multi-link messages.
- Local relative imports MUST include `.ts` extensions (`allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`).
- `Schema.TaggedError` MUST include `{ readonly brand: unique symbol; }` as the second type parameter.
- `HttpClient` tests MUST use `makeTestHttpClient` from `test/TestHttpClient.ts` (never mock global `fetch`).

## Review Focus

- Target site returns 403 locally, Firecrawl HTTP call returns 200 JSON with `success: true` and `data.metadata.statusCode: 403` -> must be treated as fallback failure and preserve original local `HttpNetworkError` (403).
- Target site returns 403 locally, Firecrawl returns 429 (`HttpRateLimitError`) -> fallback fast-fails, logs `"firecrawl"` engine failure, and preserves original target 403 error rather than reporting target 429.
- Multi-link message has 4 blocked URLs concurrently processed by `scrapeAll(..., { concurrency: "unbounded" })` -> `FallbackScraper` semaphore bounds active fallback requests to at most 2.
- Fallback engine returns `rawHtml` with missing `<meta name="description">`, or returns an array for `metadata.title` / `metadata.ogImage` -> `rawHtml` feeds `metascraper` + `firstParagraphPlugin`, and array metadata normalizes to first non-empty string (with SVG `image` still filtered).
- `danbooruCustomizer.scrape` swallows 403 and falls through to `fetchText` -> `fetchText` 403 triggers `FallbackScraper` once without duplicating fallback logic inside customizers.

---

### Task 1: Add Optional `FIRECRAWL_API_KEY` Configuration

**Files:**
- Modify: `src/Config.ts`
- Modify: `.env.example`
- Test: `test/Config.test.ts`

**Interfaces:**
- Produces: `BotConfig.firecrawlApiKey?: Redacted.Redacted<string>` (loaded from optional `FIRECRAWL_API_KEY`).

- [ ] **Step 1: Write failing tests in `test/Config.test.ts`**

In `"loads configuration and defaults optional keys to undefined"`, assert:
```ts
expect(result.firecrawlApiKey).toBeUndefined();
```
In `"reads all optional environment configs when provided"`, add `FIRECRAWL_API_KEY: "fc_test_key"` to `fromEnvRecord` and assert:
```ts
expect(config.firecrawlApiKey).toBeDefined();
expect(Redacted.value(config.firecrawlApiKey!)).toBe("fc_test_key");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/Config.test.ts`
Expected: FAIL (`config.firecrawlApiKey` is `undefined`).

- [ ] **Step 3: Implement `firecrawlApiKey` in `src/Config.ts` and document in `.env.example`**

Add optional `readonly firecrawlApiKey?: Redacted.Redacted<string>` to `BotConfig` interface and `Config.option(Config.Redacted("FIRECRAWL_API_KEY")).pipe(Config.map(Option.getOrUndefined))` to `BotConfig` object.
Add `# FIRECRAWL_API_KEY=fc-your_api_key_here` comment block to `.env.example`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/Config.test.ts`
Expected: PASS (3 tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/Config.ts .env.example test/Config.test.ts
git commit -m "config: add optional FIRECRAWL_API_KEY setting"
```

---

### Task 2: Implement Generic `FallbackScraper` Service & Firecrawl Engine

**Files:**
- Create: `src/features/link-preview/FallbackScraper.ts`
- Test: `test/features/link-preview/FallbackScraper.test.ts`

**Interfaces:**
- Produces in `src/features/link-preview/FallbackScraper.ts`:
  - `export interface FallbackMetadata { readonly title?: string; readonly description?: string; readonly image?: string; }`
  - `export interface FallbackScrapeResult { readonly engineId: string; readonly url: string; readonly html?: string; readonly metadata?: FallbackMetadata; }`
  - `export class FallbackScrapeError extends Schema.TaggedError<FallbackScrapeError, { readonly brand: unique symbol; }>()("FallbackScrapeError", { engineId: Schema.String, url: Schema.String, reason: Schema.String, status: Schema.optional(Schema.Finite) })`
  - `export interface ScraperEngine { readonly id: string; readonly scrape: (url: string) => Effect.Effect<FallbackScrapeResult, FallbackScrapeError>; }`
  - `export function createFirecrawlEngine(httpClient: HttpClient.HttpClient, apiKey?: Redacted.Redacted<string>): ScraperEngine`
  - `export class FallbackScraper extends Context.Service<FallbackScraper, { readonly scrape: (url: string) => Effect.Effect<FallbackScrapeResult, FallbackScrapeError>; }>()("sakurako/link-preview/FallbackScraper")` with:
    - `static readonly DEFAULT_CONCURRENCY = 2`
    - `static fromEngines(engines: ReadonlyArray<ScraperEngine>, concurrency?: number): FallbackScraper["Service"]`
    - `static layerFromEngines(engines: ReadonlyArray<ScraperEngine>, concurrency?: number): Layer.Layer<FallbackScraper>`
    - `static readonly layer: Layer.Layer<FallbackScraper, never, HttpClient.HttpClient>`

- [ ] **Step 1: Write failing tests in `test/features/link-preview/FallbackScraper.test.ts`**

Write tests covering:
1. Firecrawl engine sends `POST https://api.firecrawl.dev/v2/scrape` with JSON `{ url, formats: ["rawHtml"], timeout: 25000 }`, no `Authorization` header when `apiKey` is omitted, and `Authorization: Bearer fc-key` when `apiKey` is provided; parses `rawHtml` and `metadata` (`ogTitle ?? title`, `ogDescription ?? description`, `ogImage`, including string arrays).
2. Firecrawl engine fails with `FallbackScrapeError` when `success: false`, when `data.metadata.statusCode` is `403` / `404` / `500` even if `success: true`, or when both `rawHtml` and structured `metadata` are empty.
3. Firecrawl engine fast-fails on HTTP `429` (`HttpRateLimitError`) without retrying and maps the failure to `FallbackScrapeError` (`engineId: "firecrawl"`).
4. `FallbackScraper.fromEngines` falls back sequentially when engine 1 fails and engine 2 succeeds (logging a warning for engine 1), and fails when all engines fail or engine list is empty.
5. `FallbackScraper.fromEngines(..., 2)` bounds concurrent in-flight engine calls to at most 2 when 4 `scrape` calls run concurrently via `Effect.forEach(..., { concurrency: "unbounded" })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/FallbackScraper.test.ts`
Expected: FAIL (`FallbackScraper.ts` not found).

- [ ] **Step 3: Implement `src/features/link-preview/FallbackScraper.ts`**

Key implementation rules:
- Use `HttpClient.HttpClient` captured in `createFirecrawlEngine(httpClient, apiKey)` via `Effect.provideService(HttpClient.HttpClient, httpClient)` around `fetchJson(request, FirecrawlScrapeResponseSchema, { timeoutDuration: "30 seconds" })` so `ScraperEngine.scrape` has `R = never`.
- Normalize Firecrawl `string | readonly string[]` metadata fields by taking the first trimmed non-empty string.
- Resolve target URL from `data.metadata?.url ?? data.metadata?.sourceURL ?? url`.
- Validate `statusCode` (`statusCode !== undefined && statusCode !== null && (statusCode < 200 || statusCode >= 300)` -> fail `FallbackScrapeError`).
- Use `Semaphore.makeUnsafe(concurrency)` in `FallbackScraper.fromEngines` wrapping the engine fallback chain via `semaphore.withPermit(...)`.
- In `FallbackScraper.layer`, read `HttpClient.HttpClient` and `Effect.option(BotConfig)` to get `firecrawlApiKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/FallbackScraper.test.ts`
Expected: PASS (all tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/FallbackScraper.ts test/features/link-preview/FallbackScraper.test.ts
git commit -m "link-preview: add generic FallbackScraper service with Firecrawl engine"
```

---

### Task 3: Integrate `FallbackScraper` into `LinkPreview.ts`

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewEngine.test.ts`
- Test: `test/features/link-preview/LinkPreviewBot.test.ts`

**Interfaces:**
- Consumes: `FallbackScraper`, `FallbackScrapeResult` from `./FallbackScraper.ts`
- Produces: `export function shouldTriggerFallback(error: ScrapeMetadataError): boolean` in `src/features/link-preview/LinkPreview.ts`; `scrapeMetadata(url)` uses `Effect.serviceOption(FallbackScraper)` on recoverable errors.

- [ ] **Step 1: Write failing tests in `LinkPreviewEngine.test.ts` and `LinkPreviewBot.test.ts`**

In `test/features/link-preview/LinkPreviewEngine.test.ts`, add a `describe("fallback scraping", ...)` block testing:
1. Local `403`, `401`, `429`, and timeout (`HttpTimeoutError`) trigger `FallbackScraper.scrape(url)` and parse returned `rawHtml` through `metascraper` (including `firstParagraphPlugin` and `LinkPreviewSites` rules such as Hacker News), filling missing fields from `fallback.metadata` while still rejecting SVG images.
2. When a fallback engine returns only `metadata` (no `html`), `scrapeMetadata` builds `PageMetadata` from `metadata` (still filtering SVG images).
3. Local `404` (`HttpNotFoundError`) and SSRF `BlockedHostError` NEVER invoke `FallbackScraper.scrape`.
4. When `FallbackScraper.scrape` fails (including when Firecrawl itself returns `429`), `scrapeMetadata` preserves and returns the original local error (e.g. `HttpNetworkError` with `status: 403`).
5. `danbooruCustomizer` falling through on 403 invokes `FallbackScraper` via `fetchText` fallback once.

In `test/features/link-preview/LinkPreviewBot.test.ts`, add an end-to-end test:
- Incoming message with a URL where local `GET` returns `403 Forbidden`, `FallbackScraper.layer` hits mock `POST https://api.firecrawl.dev/v2/scrape` returning valid `rawHtml` (`statusCode: 200`), and `handleLinkPreviewMessage` sends the formatted preview reply.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/features/link-preview/LinkPreviewEngine.test.ts test/features/link-preview/LinkPreviewBot.test.ts`
Expected: FAIL (`shouldTriggerFallback` not defined / fallback not invoked).

- [ ] **Step 3: Update `src/features/link-preview/LinkPreview.ts`**

- Extract `parseHtmlMetadata(originalUrl: string, html: string, targetUrl: string)` sharing `scraper({ html, url: targetUrl })` and SVG filtering.
- Export `shouldTriggerFallback(error: ScrapeMetadataError): boolean` returning `true` only for `HttpRateLimitError`, `HttpTimeoutError`, `HttpNetworkError`.
- In `scrapeMetadata(url)`: wrap `fetchText(request)` failure handling with `Effect.catch((localError) => ...)`:
  - Check `shouldTriggerFallback(localError)` and `Effect.serviceOption(FallbackScraper)`.
  - If `Some(fallbackScraper)`: log info (`Local fetch failed for ${url} (${localError.message}), trying fallback scraper...`), call `fallbackScraper.scrape(url)`, parse `html` via `parseHtmlMetadata` (supplementing missing fields from `fallback.metadata`, filtering SVG) or construct from `fallback.metadata`.
  - If `fallbackScraper.scrape` fails: log warning (`Fallback scraper failed for ${url}: ${fallbackError.message}`) and re-fail with `localError`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/features/link-preview/`
Expected: PASS (all link-preview tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewEngine.test.ts test/features/link-preview/LinkPreviewBot.test.ts
git commit -m "link-preview: integrate generic FallbackScraper on local fetch failures"
```

---

### Task 4: Wire Production Layer, Startup Logging, Docs & Live Smoke Verification

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/config.md`
- Modify: `docs/features/link-preview.md`
- Test: `test/StartupLog.test.ts`

**Interfaces:**
- Consumes: `FallbackScraper` from `./features/link-preview/FallbackScraper.ts`
- Modifies: `logStartupInfo` and `MainLive` in `src/index.ts`.

- [ ] **Step 1: Write failing test in `test/StartupLog.test.ts`**

Add tests checking that `logStartupInfo` logs:
- `"Link preview fallback scraper enabled (Firecrawl keyless mode)"` when `firecrawlApiKey` is `undefined`.
- `"Link preview fallback scraper enabled (Firecrawl API key configured)"` when `firecrawlApiKey` is provided.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/StartupLog.test.ts`
Expected: FAIL (startup log lines not emitted).

- [ ] **Step 3: Wire `FallbackScraperLive` and startup log in `src/index.ts`, and update docs**

- In `src/index.ts`:
  - Log fallback scraper mode in `logStartupInfo`.
  - Define `FallbackScraperLive = FallbackScraper.layer.pipe(Layer.provide(FetchHttpClient.layer))` and merge into `MainLive`.
- In `docs/config.md`: document optional `FIRECRAWL_API_KEY` (notes keyless fallback works out of the box, key raises quota).
- In `docs/features/link-preview.md`: document automatic remote scraping fallback on 401/403/429/5xx/timeouts while preserving SSRF and 404 exclusions.

- [ ] **Step 4: Run full verification suite + live Bun/Effect `FetchHttpClient` smoke check**

Run:
1. `bun test` (expect all tests pass)
2. `bun run check` (expect 0 TypeScript errors)
3. `bun run lint` (expect 0 lint errors)
4. `bun run knip` (expect 0 unused exports/files)
5. Throwaway live smoke script using `bun -e` with `FetchHttpClient.layer` + `FallbackScraper.layer` + `scrapeMetadata` against `https://www.androidauthority.com/grapheneos-pixel-10-linux-6-18-pixel-11-support-3731993/` and `https://lwn.net/Articles/1105130/` (verifying `PageMetadata` extraction and `formatPreview` output without `curl`).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts docs/config.md docs/features/link-preview.md test/StartupLog.test.ts
git commit -m "app: wire FallbackScraperLive and document fallback scraping"
```

---

## Self-Review

1. **Spec coverage**:
   - `BotConfig.firecrawlApiKey` optional -> Task 1.
   - Generic `FallbackScraper` & `ScraperEngine` & `Semaphore(2)` & Firecrawl `/v2/scrape` (`rawHtml`, `timeout: 25000`, `timeoutDuration: "30 seconds"`, `statusCode` 2xx check, keyless + optional Bearer) -> Task 2.
   - `shouldTriggerFallback` (429/timeout/network vs 404/204/SSRF/parse), `parseHtmlMetadata` reuse + `metadata` supplement, original error preservation -> Task 3.
   - `MainLive` wiring, `logStartupInfo`, `docs/config.md`, `docs/features/link-preview.md`, live Bun + `FetchHttpClient` smoke check -> Task 4.
2. **Step scan**: Each step specifies exact files, signatures, assertions, and verification commands.
3. **Type consistency**: `FallbackScraper`, `ScraperEngine`, `FallbackScrapeResult`, `FallbackMetadata`, `FallbackScrapeError`, `shouldTriggerFallback`, `firecrawlApiKey` match across all tasks.
4. **Review Focus coverage**: All 5 failure modes (`statusCode: 403` inside 200 JSON, Firecrawl 429 preserving target 403, semaphore bounding 4 concurrent calls to 2, array metadata + `firstParagraphPlugin` + SVG filter, Danbooru 403 fallthrough) are mapped directly to tests in Tasks 2 and 3.
