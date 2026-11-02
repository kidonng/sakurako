# Pixiv Original Image Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide full-resolution Pixiv artwork preview images using `https://pixiv.cat/` while gracefully falling back to standard `og:image` if pixiv.cat is unavailable.

**Architecture:** Add `pixivCustomizer` in `LinkPreviewSites.ts` to extract artwork IDs and construct `https://pixiv.cat/${illustId}.jpg` alongside `fallbackImage` from HTML `og:image`. Extend `PageMetadata`, `FormattedPreview`, and `prepareOutgoingImage` in `LinkPreview.ts` to attempt the candidate pixiv.cat image first and fall back to `fallbackImage` if primary image retrieval fails.

**Tech Stack:** TypeScript 7, Effect 4 (`effect`, `@effect/platform`), Bun 1.4.x, bun:test

**Spec:** `.superpowers/specs/2026-11-02-pixiv-original-image-preview-design.md`

## Global Constraints
- Target Bun runtime: Pinned Bun 1.4.4.
- Verbatim module syntax: `import type { ... }` or `import { type Foo, Bar } from "..."` and always `.ts` extension for relative imports.
- No `any` or `as any`.
- Effect 4 idioms: `Effect.fn`, `Effect.gen`, `Schema.TaggedError` with `{ readonly brand: unique symbol }`.
- Test commands: `bun test`, typecheck: `bun run check`, lint: `bun run lint`.
- All Git commit messages: Linux Kernel commit style (`scope: Short imperative summary` with `### Problem`, `### Solution`, `### References`).

## Review Focus
- Pixiv URLs with language prefixes (e.g. `https://www.pixiv.net/en/artworks/82775556`) - should correctly extract artwork ID and map to pixiv.cat.
- Legacy Pixiv URLs (e.g. `https://www.pixiv.net/member_illust.php?mode=medium&illust_id=82775556`) - should correctly extract artwork ID.
- Non-artwork Pixiv URLs (e.g. `https://www.pixiv.net/users/12345` or `https://www.pixiv.net/ranking.php`) - should return undefined for image/fallbackImage to allow default metascraper rules to run.
- pixiv.cat returns 404 or fails - `prepareOutgoingImage` should fall back to `fallbackImageUrl` and successfully return the fallback image Base64.
- Both pixiv.cat and `fallbackImage` fail - `prepareOutgoingImage` returns `undefined`, and `handleLinkPreviewMessage` falls back to sending text-only preview.

---

### Task 1: Pixiv site customizer and artwork ID extraction

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts:21-37,123-138,150-173`
- Test: `test/features/link-preview/LinkPreviewSites.test.ts`

**Interfaces:**
- Consumes: `SiteCustomizer`, `MetascraperRuleContext`
- Produces:
  ```ts
  export function extractPixivArtworkId(url: URL): string | undefined;
  export const pixivCustomizer: SiteCustomizer;
  ```
  and extended `fallbackImage` in `SiteCustomizer.metascraperRules` and `siteMetascraperPlugin`.

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/LinkPreviewSites.test.ts`**

Add tests to `describe("LinkPreviewSites")`:
```ts
describe("pixivCustomizer", () => {
  it("matches pixiv.net and www.pixiv.net", () => {
    expect(findSiteCustomizer("https://www.pixiv.net/artworks/82775556")?.name).toBe("pixiv.net");
    expect(findSiteCustomizer("https://pixiv.net/artworks/82775556")?.name).toBe("pixiv.net");
    expect(findSiteCustomizer("https://other.com/artworks/82775556")).toBeUndefined();
  });

  it("extracts pixiv.cat image URL from standard artwork path", () => {
    const url = new URL("https://www.pixiv.net/artworks/82775556");
    const image = pixivCustomizer.metascraperRules?.image?.({
      url: url.href,
      htmlDom: cheerio.load("<html></html>"),
    });
    expect(image).toBe("https://pixiv.cat/82775556.jpg");
  });

  it("extracts pixiv.cat image URL with language prefix", () => {
    const url = new URL("https://www.pixiv.net/en/artworks/82775556");
    const image = pixivCustomizer.metascraperRules?.image?.({
      url: url.href,
      htmlDom: cheerio.load("<html></html>"),
    });
    expect(image).toBe("https://pixiv.cat/82775556.jpg");
  });

  it("extracts pixiv.cat image URL from legacy member_illust.php path", () => {
    const url = new URL("https://www.pixiv.net/member_illust.php?mode=medium&illust_id=82775556");
    const image = pixivCustomizer.metascraperRules?.image?.({
      url: url.href,
      htmlDom: cheerio.load("<html></html>"),
    });
    expect(image).toBe("https://pixiv.cat/82775556.jpg");
  });

  it("returns undefined for non-artwork URLs", () => {
    const userUrl = new URL("https://www.pixiv.net/users/12345");
    expect(pixivCustomizer.metascraperRules?.image?.({
      url: userUrl.href,
      htmlDom: cheerio.load("<html></html>"),
    })).toBeUndefined();

    const rankingUrl = new URL("https://www.pixiv.net/ranking.php");
    expect(pixivCustomizer.metascraperRules?.image?.({
      url: rankingUrl.href,
      htmlDom: cheerio.load("<html></html>"),
    })).toBeUndefined();
  });

  it("extracts fallbackImage from og:image or twitter:image", () => {
    const html = `<html><head><meta property="og:image" content="https://embed.pixiv.net/decorate.php?illust_id=82775556"></head></html>`;
    const fallback = pixivCustomizer.metascraperRules?.fallbackImage?.({
      url: "https://www.pixiv.net/artworks/82775556",
      htmlDom: cheerio.load(html),
    });
    expect(fallback).toBe("https://embed.pixiv.net/decorate.php?illust_id=82775556");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
Expected: FAIL (cannot find `pixivCustomizer` or property does not exist).

- [ ] **Step 3: Implement `extractPixivArtworkId` and `pixivCustomizer` in `src/features/link-preview/LinkPreviewSites.ts`**

1. Extend `SiteCustomizer.metascraperRules`:
```ts
export interface SiteCustomizer {
  readonly name: string;
  readonly match: (url: URL) => boolean;
  readonly userAgent?: string;
  readonly fetchImageLocally?: boolean;
  readonly metascraperRules?: {
    readonly description?: (
      context: MetascraperRuleContext,
    ) => string | undefined;
    readonly title?: (context: MetascraperRuleContext) => string | undefined;
    readonly image?: (context: MetascraperRuleContext) => string | undefined;
    readonly fallbackImage?: (
      context: MetascraperRuleContext,
    ) => string | undefined;
  };
  readonly formatItem?: (params: {
    readonly metadata: PageMetadata;
    readonly isSingle: boolean;
  }) => SiteFormatOptions;
}
```

2. Implement `extractPixivArtworkId(rawUrl: string | URL): string | undefined`:
Match `pathname` against `^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)` or `pathname === "/member_illust.php"` with `searchParams.get("illust_id")`.

3. Define `pixivCustomizer: SiteCustomizer`:
- `name: "pixiv.net"`
- `match`: hostname is `pixiv.net` or `www.pixiv.net`
- `metascraperRules`:
  - `image`: if `extractPixivArtworkId(url)` returns `id`, return `https://pixiv.cat/${id}.jpg`
  - `fallbackImage`: if `extractPixivArtworkId(url)`, extract `htmlDom('meta[property="og:image"]').attr("content") || htmlDom('meta[property="twitter:image"]').attr("content") || htmlDom('meta[name="twitter:image"]').attr("content")`
4. Update `siteMetascraperPlugin()` to add `fallbackImage`:
```ts
fallbackImage: [
  ({ htmlDom, url }: MetascraperRuleContext) => {
    const customizer = findSiteCustomizer(url);
    return customizer?.metascraperRules?.fallbackImage?.({ htmlDom, url });
  },
],
```
5. Add `pixivCustomizer` to `siteCustomizers` array.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreviewSites.ts test/features/link-preview/LinkPreviewSites.test.ts
git commit -m "link-preview: Add Pixiv customizer with pixiv.cat image and og:image fallback rules"
```

---

### Task 2: Image fallback support in PageMetadata, FormattedPreview, and prepareOutgoingImage

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts:78-83,152-155,187-303,363-408,410-503,559-570`
- Test: `test/features/link-preview/LinkPreviewEngine.test.ts`
- Test: `test/features/link-preview/LinkPreviewFormat.test.ts`

**Interfaces:**
- Consumes: `pixivCustomizer`, `siteMetascraperPlugin`
- Produces:
  ```ts
  export interface PageMetadata {
    readonly url: string;
    readonly title?: string;
    readonly description?: string;
    readonly image?: string;
    readonly fallbackImage?: string;
  }

  export interface FormattedPreview {
    readonly text: string;
    readonly image?: string;
    readonly fallbackImage?: string;
  }

  export interface PrepareImageOptions {
    readonly fallbackImageUrl?: string;
    readonly timeoutDuration?: Duration.Input;
  }

  export const prepareOutgoingImage: (
    imageUrl: string,
    options?: PrepareImageOptions | Duration.Input,
  ) => Effect.Effect<string | undefined, never, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write failing tests in `LinkPreviewFormat.test.ts` and `LinkPreviewEngine.test.ts`**

1. In `test/features/link-preview/LinkPreviewFormat.test.ts`:
```ts
it("preserves fallbackImage for single successful URL when provided", () => {
  const results: ScrapingResult[] = [
    {
      _tag: "Success",
      data: {
        url: "https://www.pixiv.net/artworks/82775556",
        title: "Artwork Title",
        image: "https://pixiv.cat/82775556.jpg",
        fallbackImage: "https://embed.pixiv.net/decorate.php?illust_id=82775556",
      },
    },
  ];
  const formatted = formatPreview(results);
  expect(formatted).toEqual({
    text: "Artwork Title",
    image: "https://pixiv.cat/82775556.jpg",
    fallbackImage: "https://embed.pixiv.net/decorate.php?illust_id=82775556",
  });
});
```

2. In `test/features/link-preview/LinkPreviewEngine.test.ts`:
```ts
it("falls back to fallbackImageUrl when primary image fails with 404", async () => {
  const fallbackBytes = new Uint8Array([1, 2, 3, 4]);
  const layer = makeTestHttpClient((req) => {
    if (req.url === "https://pixiv.cat/82775556.jpg") {
      return new Response("Not Found", { status: 404 });
    }
    if (req.url === "https://embed.pixiv.net/decorate.php?illust_id=82775556") {
      return new Response(fallbackBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    return new Response("", { status: 500 });
  });

  const result = await Effect.runPromise(
    prepareOutgoingImage("https://pixiv.cat/82775556.jpg", {
      fallbackImageUrl: "https://embed.pixiv.net/decorate.php?illust_id=82775556",
    }).pipe(Effect.provide(layer)),
  );

  const expectedBase64 = `base64://${Buffer.from(fallbackBytes).toString("base64")}`;
  expect(result).toBe(expectedBase64);
});

it("returns undefined when both primary image and fallbackImageUrl fail", async () => {
  const layer = makeTestHttpClient(() => new Response("Not Found", { status: 404 }));

  const result = await Effect.runPromise(
    prepareOutgoingImage("https://pixiv.cat/82775556.jpg", {
      fallbackImageUrl: "https://embed.pixiv.net/decorate.php?illust_id=82775556",
    }).pipe(Effect.provide(layer)),
  );

  expect(result).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewFormat.test.ts test/features/link-preview/LinkPreviewEngine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement fallback support in `src/features/link-preview/LinkPreview.ts`**

1. In `PageMetadata` and `FormattedPreview`:
Add optional `readonly fallbackImage?: string;`.
2. In `scrapeMetadata`:
Extract `fallbackImage` from `metadata.fallbackImage`:
```ts
const rawFallbackImage = metadata.fallbackImage?.trim() || undefined;
const fallbackImage =
  rawFallbackImage && !isSvgUrl(rawFallbackImage) ? rawFallbackImage : undefined;
```
Include `fallbackImage` in returned `PageMetadata`.
3. In `formatPreview`:
Populate `fallbackImage` in returned `FormattedPreview` when `item.fallbackImage` is present and not an SVG.
4. Update `prepareOutgoingImage`:
Accept `options?: PrepareImageOptions | Duration.Input`.
Define inner download helper `downloadImage(targetUrl: string, timeout: Duration.Input)`.
Try `downloadImage(imageUrl, timeoutDuration)`. If it returns `undefined` and `fallbackImageUrl` is present, log warning and call `downloadImage(fallbackImageUrl, timeoutDuration)`.
5. In `handleLinkPreviewMessage`:
Pass `{ fallbackImageUrl: formatted.fallbackImage }` to `prepareOutgoingImage(formatted.image, { fallbackImageUrl: formatted.fallbackImage })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/features/link-preview/LinkPreviewFormat.test.ts test/features/link-preview/LinkPreviewEngine.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to ensure no regressions**

Run: `bun test`
Expected: PASS (all tests pass)

- [ ] **Step 6: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewFormat.test.ts test/features/link-preview/LinkPreviewEngine.test.ts
git commit -m "link-preview: Support candidate image fallback in metadata scraping and image download"
```

---

### Task 3: Integration verification for Pixiv link preview in LinkPreviewBot

**Files:**
- Test: `test/features/link-preview/LinkPreviewBot.test.ts`

**Interfaces:**
- Consumes: `handleLinkPreviewMessage`, `makeTestHttpClient`

- [ ] **Step 1: Write integration tests in `test/features/link-preview/LinkPreviewBot.test.ts`**

Add tests to `describe("handleLinkPreviewMessage")`:
```ts
it("sends preview with pixiv.cat original image when pixiv.cat succeeds", async () => {
  const pixivHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Artwork Title - pixiv</title>
        <meta name="description" content="Artwork Description">
        <meta property="og:image" content="https://embed.pixiv.net/decorate.php?illust_id=82775556">
      </head>
      <body></body>
    </html>
  `;
  const originalBytes = new Uint8Array([9, 8, 7]);
  const layer = makeTestHttpClient((req) => {
    if (req.url === "https://www.pixiv.net/artworks/82775556") {
      return new Response(pixivHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.url === "https://pixiv.cat/82775556.jpg") {
      return new Response(originalBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    return new Response("", { status: 404 });
  });

  let sentPayload: any = null;
  const item: IncomingMessage = {
    event: {
      raw_message: "https://www.pixiv.net/artworks/82775556",
      user_id: 10001,
      self_id: 99999,
      post_type: "message",
    } as unknown as OneBotMessageEvent,
    context: {
      quote: async (payload: any) => {
        sentPayload = payload;
      },
    } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
  };

  await Effect.runPromise(
    handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
  );

  expect(sentPayload).not.toBeNull();
  expect(sentPayload[1].data.file).toBe(
    `base64://${Buffer.from(originalBytes).toString("base64")}`,
  );
});

it("falls back to og:image when pixiv.cat returns 404", async () => {
  const pixivHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Artwork Title - pixiv</title>
        <meta name="description" content="Artwork Description">
        <meta property="og:image" content="https://embed.pixiv.net/decorate.php?illust_id=82775556">
      </head>
      <body></body>
    </html>
  `;
  const croppedBytes = new Uint8Array([5, 4, 3]);
  const layer = makeTestHttpClient((req) => {
    if (req.url === "https://www.pixiv.net/artworks/82775556") {
      return new Response(pixivHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.url === "https://pixiv.cat/82775556.jpg") {
      return new Response("Not Found", { status: 404 });
    }
    if (req.url === "https://embed.pixiv.net/decorate.php?illust_id=82775556") {
      return new Response(croppedBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    return new Response("", { status: 404 });
  });

  let sentPayload: any = null;
  const item: IncomingMessage = {
    event: {
      raw_message: "https://www.pixiv.net/artworks/82775556",
      user_id: 10001,
      self_id: 99999,
      post_type: "message",
    } as unknown as OneBotMessageEvent,
    context: {
      quote: async (payload: any) => {
        sentPayload = payload;
      },
    } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
  };

  await Effect.runPromise(
    handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
  );

  expect(sentPayload).not.toBeNull();
  expect(sentPayload[1].data.file).toBe(
    `base64://${Buffer.from(croppedBytes).toString("base64")}`,
  );
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: PASS

- [ ] **Step 3: Run full typecheck and linter**

Run: `bun run check && bun run lint && bun test`
Expected: PASS with 0 errors and 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add test/features/link-preview/LinkPreviewBot.test.ts
git commit -m "link-preview: Add Pixiv original image and fallback integration tests"
```
