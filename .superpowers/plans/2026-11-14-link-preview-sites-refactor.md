# Link Preview Sites Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `LinkPreviewSites.ts` from a monolithic `SiteCustomizer` bag into three orthogonal stage registries (custom scrapers, native `createMetascraper.Rules`, and display policies) and unify display-policy evaluation in `LinkPreview.ts`.

**Architecture:** Split site customization by pipeline phase: `SiteScraper` handles pre-HTTP URL overrides (Danbooru `/posts/:id`), `siteMetascraperRules` exports native `createMetascraper.Rules[]` with `test` gates (Hacker News & Pixiv), and `SiteDisplayRule` handles post-scrape field hiding (GitHub, Hacker News, Danbooru fallback). `LinkPreview.ts` spreads `siteMetascraperRules` into `createMetascraper` and calls `prepareEffectiveScrapingResults` once inside `formatPreview` as well as pre-filter, removing repeated site lookups.

**Tech Stack:** TypeScript (`7.0.2`), Bun (`1.4.4`, `bun:test`), Effect 4 (`effect`, `effect/http`), `metascraper`, `cheerio`, `oxlint`, `knip`.

**Spec:** `.superpowers/specs/2026-11-14-link-preview-sites-refactor-design.md`

## Global Constraints

- Preserve all existing runtime preview outputs and `DecisionFilter` behavior for GitHub, Hacker News, Danbooru, and Pixiv.
- Preserve `danbooruDisplayRule` (`hideDescription: true`) for all `donmai.us` URLs, covering non-`/posts/:id` pages and `scrape` fallback paths (204, 429, timeout, network errors, `FallbackScraper`).
- Keep explicit `.ts` extensions on relative imports and `verbatimModuleSyntax` compliance (`import type` where applicable).
- Leave zero dead wrappers (`SiteCustomizer`, `MetascraperRuleContext`, `siteMetascraperPlugin`, unused `title`/`description` overrides on display policy) or unused exports flagged by `knip`.

## Review Focus

- Malformed URLs passed to `hackerNewsRules.test`, `pixivRules.test`, or `getSiteDisplayPolicy` must return `false` / `undefined` without throwing (`scrapeWithSiteOverride(url: URL)` takes an already-parsed `URL` after `scrapeMetadata` validates the string).
- Non-post Danbooru URLs (e.g. `/posts?tags=cat_ears`) must bypass `danbooruPostScraper` while still receiving `hideDescription: true` from `danbooruDisplayRule`.
- Danbooru `/posts/:id` requests failing with 429 / 204 / timeout / network errors must return `undefined` from `scrapeWithSiteOverride` so `scrapeMetadata` falls back to HTML / `FallbackScraper`, and still apply `hideDescription: true`.
- Direct calls to `formatPreview(results)` (without prior `prepareEffectiveScrapingResults`) must apply site display policies and SVG filtering identically across `hasValidPreview`, single-link, and multi-link branches.
- Non-item Hacker News URLs and non-artwork Pixiv URLs run through `createMetascraper(siteMetascraperRules)` must be gated out by each bundle's `test` function without invoking its extractors.

---

### Task 1: Split `LinkPreviewSites.ts` into three orthogonal registries and rewrite `LinkPreviewSites.test.ts`

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts`
- Modify: `test/features/link-preview/LinkPreviewSites.test.ts`

**Interfaces:**
- Consumes: `PageMetadata` from `src/features/link-preview/LinkPreview.ts`, `createMetascraper` types from `"metascraper"`, `resolveDanbooruTitle` / `DanbooruPostSchema` / `withDanbooruUserAgent` from `src/features/danbooru/*`, `fetchJson` / `HttpFetchError` from `src/utils/HttpClient.ts`.
- Produces in `src/features/link-preview/LinkPreviewSites.ts`:
  - `export const danbooruPostScraper: SiteScraper` (`SiteScraper` interface kept internal unless needed externally)
  - `export function scrapeWithSiteOverride(url: URL): Effect.Effect<PageMetadata | undefined, HttpFetchError, HttpClient.HttpClient>`
  - `export const hackerNewsRules` (typed via `satisfies createMetascraper.Rules`)
  - `export const pixivRules` (typed via `satisfies createMetascraper.Rules`)
  - `export const siteMetascraperRules: ReadonlyArray<createMetascraper.Rules>`
  - `export interface SiteDisplayPolicy` (`hideTitle?: boolean`, `hideDescription?: boolean`, `hideImage?: boolean`)
  - `export function getSiteDisplayPolicy(rawUrl: string | URL, context: { readonly isSingle: boolean }): SiteDisplayPolicy | undefined`

- [ ] **Step 1: Rewrite `test/features/link-preview/LinkPreviewSites.test.ts` against the new three-stage API**

Replace the old `findSiteCustomizer` / `SiteCustomizer` tests with tests for:
- `danbooruPostScraper` + `scrapeWithSiteOverride`:
  - matches `danbooru.donmai.us/posts/12459835`, `testbooru.donmai.us/posts/1`, `safebooru.donmai.us/posts/1`
  - returns `false` on `danbooruPostScraper.match` and `undefined` from `scrapeWithSiteOverride` for non-post URLs (`/posts?tags=cat_ears`) and unrecognized URLs (`https://example.com`) without making HTTP calls
  - fetches post JSON with `Sakurako/1.0` User-Agent and resolves Chinese tag title + `large_file_url` / `preview_file_url`
  - fails with `HttpNotFoundError` on 404
  - returns `undefined` on 429 so `scrapeMetadata` falls back to HTML
- `hackerNewsRules` + `createMetascraper(siteMetascraperRules)`:
  - `hackerNewsRules.test` returns `true` for `https://news.ycombinator.com/item?id=50268380` and `false` for frontpage, non-HN host, and invalid URL string `"not-a-url"`
  - `hackerNewsRules.description` extracts external link, decodes HTML entities, and rejects Ask HN relative/absolute `/item` links and comment pages lacking `.titleline`
  - running `createMetascraper([hackerNewsRules])` on frontpage HTML returns `description: null` because `test` gates out the rule
- `pixivRules` + `createMetascraper(siteMetascraperRules)`:
  - `pixivRules.test` returns `true` for `/artworks/82775556` and `/en/artworks/82775556` on `pixiv.net` / `www.pixiv.net`, and `false` for `/users/12345`, `/ranking.php`, `other.com/artworks/82775556`, and `"not-a-url"`
  - `pixivRules.image` returns `https://pixiv.cat/82775556.jpg`
  - `pixivRules.fallbackImage` extracts `og:image` / `twitter:image`
  - running `createMetascraper([pixivRules])` on `/users/12345` returns `image: null` because `test` gates out the rule
- `getSiteDisplayPolicy`:
  - `https://github.com/kidonng/sakurako` and `https://GITHUB.COM/owner/repo`: `{ hideDescription: true, hideTitle: true }` when `isSingle: true`, `{ hideDescription: true, hideTitle: false }` when `isSingle: false`
  - `https://news.ycombinator.com/item?id=12345`: `{ hideImage: true }`
  - `https://danbooru.donmai.us/posts/12459835` and `https://danbooru.donmai.us/posts?tags=cat_ears`: `{ hideDescription: true }`
  - `https://example.com` and `"not-a-valid-url"`: `undefined`

- [ ] **Step 2: Run the updated test file to verify it fails before implementation**

Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
Expected: FAIL with missing exports (`danbooruPostScraper`, `scrapeWithSiteOverride`, `hackerNewsRules`, `pixivRules`, `getSiteDisplayPolicy`, etc.).

- [ ] **Step 3: Refactor `src/features/link-preview/LinkPreviewSites.ts` to implement the three orthogonal registries**

Implement:
- Helper `parseUrlSafe(rawUrl: string | URL): URL | undefined` so `test` and `getSiteDisplayPolicy` never throw on malformed URLs.
- `SiteScraper` (internal), `danbooruPostScraper`, `siteScrapers`, and `scrapeWithSiteOverride(url: URL)` returning `Effect.succeed(undefined)` when no scraper matches.
- `hackerNewsRules` (`pkgName: "site:hacker-news"`, `test`, `description` without duplicate hostname/item checks) and `pixivRules` (`pkgName: "site:pixiv"`, `test`, `image`, `fallbackImage`), each typed with `satisfies createMetascraper.Rules`, bundled into `siteMetascraperRules`.
- `SiteDisplayPolicy`, `SiteDisplayRule` (internal), `githubDisplayRule`, `hackerNewsDisplayRule`, `danbooruDisplayRule`, `siteDisplayRules`, and `getSiteDisplayPolicy(rawUrl, context)`.
- Remove `SiteCustomizer`, `SiteFormatOptions`, `MetascraperRuleContext`, `findSiteCustomizer`, `siteMetascraperPlugin`, and old customizer exports so `knip` sees zero unused exports.

- [ ] **Step 4: Run `LinkPreviewSites.test.ts` to verify all unit tests pass**

Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
Expected: PASS (all tests in `LinkPreviewSites.test.ts` green).

---

### Task 2: Migrate `LinkPreview.ts` to the three-stage site API and unify display-policy evaluation

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts:32-92,217-388,595-604`

**Interfaces:**
- Consumes from `src/features/link-preview/LinkPreviewSites.ts`:
  - `siteMetascraperRules`
  - `scrapeWithSiteOverride`
  - `getSiteDisplayPolicy`
- Produces in `src/features/link-preview/LinkPreview.ts`:
  - `prepareEffectiveScrapingResults(results: ReadonlyArray<ScrapingResult>, isSingle: boolean): ReadonlyArray<ScrapingResult>` (module-internal, used by `handleLinkPreviewMessage` and `formatPreview`)
  - Existing public exports (`formatPreview`, `scrapeMetadata`, `scrapeAll`, `handleLinkPreviewMessage`, etc.) with identical signatures and behavior.

- [ ] **Step 1: Update `LinkPreview.ts` imports and `scraper` / `firstParagraphPlugin` definitions**

- Replace imports from `./LinkPreviewSites.ts` with `{ getSiteDisplayPolicy, scrapeWithSiteOverride, siteMetascraperRules }`.
- Change `firstParagraphPlugin` parameter type from `MetascraperRuleContext` to `createMetascraper.RulesTestOptions`.
- Spread `...siteMetascraperRules` into `createMetascraper([...])`.

- [ ] **Step 2: Update `scrapeMetadata` to call `scrapeWithSiteOverride(urlObj)`**

Replace `findSiteCustomizer(urlObj)` + `customizer?.scrape` with:
```ts
const customMetadata = yield* scrapeWithSiteOverride(urlObj);
if (customMetadata) {
  return customMetadata;
}
```

- [ ] **Step 3: Simplify `prepareEffectiveScrapingResults` and deduplicate `formatPreview`**

- Update `prepareEffectiveScrapingResults` to call `getSiteDisplayPolicy(item.url, { isSingle })` and strip `hideTitle` / `hideDescription` / `hideImage` / SVG URLs.
- In `formatPreview(results)`, normalize once at entry:
  `const effectiveResults = prepareEffectiveScrapingResults(results, results.length === 1);`
  Then update `hasValidPreview`, the single-result branch, and the multi-result branch to read `data.title`, `data.description`, `data.image`, `data.fallbackImage` directly from `effectiveResults` without calling `getSiteDisplayPolicy` or `isSvgUrl` again.

- [ ] **Step 4: Run full link-preview test suite, type check, linter, and `knip`**

Run:
```bash
bun test test/features/link-preview/
bun run check
bun run lint
bun run knip
```
Expected: All `test/features/link-preview/` tests PASS, `tsc` exits 0, `oxlint` exits 0, `knip` reports no unused exports/files/deps.

- [ ] **Step 5: Commit**

Stage `LinkPreviewSites.ts`, `LinkPreview.ts`, `LinkPreviewSites.test.ts`, the spec, and the plan, then commit using Linux Kernel commit style (`link-preview: Split site customizers into orthogonal stage registries` with `### Problem` and `### Solution` sections).
