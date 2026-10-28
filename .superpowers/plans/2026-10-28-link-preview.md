# Link Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a link preview feature to Sakurako that extracts URLs from chat messages, fetches page metadata (title, description, image) via `metascraper`, truncates text according to East Asian Width (CJK = 2, ASCII = 1, max width 100), formats single or multi-link previews, and replies using quote replies (`context.quote`).

**Architecture:** Split functionality into modular layers: `src/TextWidth.ts` provides pure East Asian Width calculation and truncation; `src/LinkPreview.ts` manages URL extraction, metadata scraping with concurrency and timeout, pure message formatting, and quote reply dispatch; `src/index.ts` combines incoming message handlers into a concurrent stream processor.

**Tech Stack:** TypeScript 7, Bun, Effect 4 (`effect`, `@effect/platform-bun`), `@snowluma/sdk`, `get-urls`, `metascraper`, `metascraper-title`, `metascraper-description`, `metascraper-image`.

**Spec:** `.superpowers/specs/2026-10-28-link-preview-design.md`

## Global Constraints

- Runtime: Bun with `verbatimModuleSyntax: true` and local `.ts` import extensions.
- Dependency overrides: `"re2": "npm:empty-npm-package@1.0.0"` in `package.json` to prevent native addon crashes on Bun Canary.
- Character width: CJK and Fullwidth count as 2, ASCII and Halfwidth count as 1. Max width 100. Over-length text truncates to $\le 97$ width and appends `...`.
- Formatting rules:
  - Missing title: display `（无标题）`.
  - Missing description or image: omit the line/media directly without empty lines.
  - Multi-link: numbered `1. [标题]\n[描述]`, failed items as `序号. [提取失败：原因]`, only the first successfully fetched image attached at the end.
  - Silence on full failure: if all URLs fail, do not send any reply.
- Anti-loop guard: `event.post_type !== "message_sent" && event.user_id !== event.self_id`.
- Commit style: Linux Kernel commit format.

## Review Focus

1. Boundary wide character in `truncate`: text at width 96 followed by a 2-width CJK character and `...` (width 3) must stop at 96 to ensure total width $\le 100$ (pinned to Task 1).
2. Trailing punctuation or brackets around URLs in chat messages: URL extraction must strip trailing dots or parentheses and produce a clean URL (pinned to Task 2).
3. Duplicate URLs in a single chat message: identical URLs must be deduplicated in order, treating a message with repeated identical links as a single link (pinned to Task 2).
4. First successful URL has no image but a subsequent URL has an image: multi-link formatting must scan and pick the first available image among all successes (pinned to Task 3).
5. All links fail in multi-link message: formatting must return `null` so the bot sends no message (pinned to Task 3).

---

### Task 1: Text Width & Truncation Module

**Files:**
- Create: `src/TextWidth.ts`
- Test: `test/TextWidth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function getCharacterWidth(char: string): number
  export function getStringWidth(text: string): number
  export function truncate(text: string, maxWidth?: number, ellipsis?: string): string
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/TextWidth.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { getCharacterWidth, getStringWidth, truncate } from "../src/TextWidth.ts"

describe("TextWidth", () => {
  it("calculates character width correctly", () => {
    expect(getCharacterWidth("a")).toBe(1)
    expect(getCharacterWidth("1")).toBe(1)
    expect(getCharacterWidth("中")).toBe(2)
    expect(getCharacterWidth("文")).toBe(2)
    expect(getCharacterWidth("，")).toBe(2)
    expect(getCharacterWidth("🌸")).toBe(2)
  })

  it("calculates string width correctly", () => {
    expect(getStringWidth("hello")).toBe(5)
    expect(getStringWidth("你好")).toBe(4)
    expect(getStringWidth("hello 你好")).toBe(10)
  })

  it("returns original text if width <= maxWidth", () => {
    expect(truncate("hello", 100)).toBe("hello")
    expect(truncate("短文本", 100)).toBe("短文本")
  })

  it("truncates long ASCII text to <= maxWidth with ellipsis", () => {
    const text = "a".repeat(120)
    const result = truncate(text, 100)
    expect(getStringWidth(result)).toBeLessThanOrEqual(100)
    expect(result.endsWith("...")).toBe(true)
    expect(result).toBe("a".repeat(97) + "...")
  })

  it("truncates long CJK text to <= maxWidth with ellipsis", () => {
    const text = "中".repeat(60) // 120 width
    const result = truncate(text, 100)
    expect(getStringWidth(result)).toBeLessThanOrEqual(100)
    expect(result.endsWith("...")).toBe(true)
    // 97 max content width: 48 CJK chars = 96 width, + "..." (3 width) = 99 <= 100
    expect(result).toBe("中".repeat(48) + "...")
  })

  it("handles boundary wide character without exceeding maxWidth", () => {
    // 96 ASCII chars (width 96) + 1 CJK char (width 2) = 98 width
    // With 3-char ellipsis (width 3), 96 + 3 = 99 <= 100; but adding CJK would be 96 + 2 + 3 = 101 > 100
    const text = "a".repeat(96) + "中" + "b".repeat(20)
    const result = truncate(text, 100)
    expect(getStringWidth(result)).toBeLessThanOrEqual(100)
    expect(result).toBe("a".repeat(96) + "...")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/TextWidth.test.ts`
Expected: FAIL ("Cannot find module '../src/TextWidth.ts'")

- [ ] **Step 3: Implement `src/TextWidth.ts`**

Implement East Asian Width regex and `truncate` logic:
```ts
const CJK_REGEX =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u

export function getCharacterWidth(char: string): number {
  if (char.length === 0) return 0
  return CJK_REGEX.test(char) || (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1
}

export function getStringWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += getCharacterWidth(char)
  }
  return width
}

export function truncate(text: string, maxWidth = 100, ellipsis = "..."): string {
  const totalWidth = getStringWidth(text)
  if (totalWidth <= maxWidth) {
    return text
  }

  const ellipsisWidth = getStringWidth(ellipsis)
  const targetContentWidth = maxWidth - ellipsisWidth
  let currentWidth = 0
  let truncatedContent = ""

  for (const char of text) {
    const charWidth = getCharacterWidth(char)
    if (currentWidth + charWidth > targetContentWidth) {
      break
    }
    currentWidth += charWidth
    truncatedContent += char
  }

  return truncatedContent + ellipsis
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/TextWidth.test.ts`
Expected: PASS (all 6 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/TextWidth.ts test/TextWidth.test.ts
git commit -m "text-width: Add East Asian Width calculation and truncation"
```

---

### Task 2: Link Extraction & Metadata Scraping Engine

**Files:**
- Create: `src/LinkPreview.ts` (scraping types and functions)
- Test: `test/LinkPreviewEngine.test.ts`

**Interfaces:**
- Consumes: `src/TextWidth.ts`
- Produces:
  ```ts
  export interface PageMetadata {
    readonly url: string
    readonly title?: string
    readonly description?: string
    readonly image?: string
  }

  export type ScrapingResult =
    | { readonly _tag: "Success"; readonly data: PageMetadata }
    | { readonly _tag: "Failure"; readonly url: string; readonly reason: string }

  export function extractUrls(text: string): ReadonlyArray<string>
  export function scrapeMetadata(
    url: string,
    fetchFn?: typeof fetch
  ): Effect.Effect<PageMetadata, string>
  export function scrapeAll(
    urls: ReadonlyArray<string>,
    fetchFn?: typeof fetch
  ): Effect.Effect<ReadonlyArray<ScrapingResult>, never>
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/LinkPreviewEngine.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { extractUrls, scrapeAll, scrapeMetadata } from "../src/LinkPreview.ts"

describe("LinkPreviewEngine", () => {
  it("extracts and normalizes URLs from text", () => {
    const text = "Check out https://github.com and http://example.com/test?a=1"
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://github.com/", "http://example.com/test?a=1"])
  })

  it("strips trailing punctuation and parentheses from URLs", () => {
    const text = "Visit (https://example.com/doc) and https://example.com/end."
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://example.com/doc", "https://example.com/end"])
  })

  it("deduplicates identical URLs while preserving order", () => {
    const text = "https://example.com https://test.org https://example.com"
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://example.com/", "https://test.org/"])
  })

  it("scrapes metadata from HTML successfully", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="A cool test page">
          <meta property="og:image" content="https://example.com/cover.png">
        </head>
        <body>Hello</body>
      </html>
    `
    const mockFetch = async () => new Response(mockHtml, { status: 200 })
    const result = await Effect.runPromise(scrapeMetadata("https://example.com", mockFetch as unknown as typeof fetch))

    expect(result.url).toBe("https://example.com")
    expect(result.title).toBe("Test Page")
    expect(result.description).toBe("A cool test page")
    expect(result.image).toBe("https://example.com/cover.png")
  })

  it("handles missing title, description, image gracefully", async () => {
    const mockHtml = "<html><head></head><body>No meta</body></html>"
    const mockFetch = async () => new Response(mockHtml, { status: 200 })
    const result = await Effect.runPromise(scrapeMetadata("https://example.com", mockFetch as unknown as typeof fetch))

    expect(result.url).toBe("https://example.com")
    expect(result.title).toBeUndefined()
    expect(result.description).toBeUndefined()
    expect(result.image).toBeUndefined()
  })

  it("fails when HTTP status is not 200", async () => {
    const mockFetch = async () => new Response("Not Found", { status: 404, statusText: "Not Found" })
    const program = scrapeMetadata("https://example.com/missing", mockFetch as unknown as typeof fetch)
    const error = await Effect.runPromise(program.pipe(Effect.flip))

    expect(error).toContain("HTTP 404")
  })

  it("scrapeAll aggregates successes and failures concurrently", async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input)
      if (urlStr.includes("fail")) {
        return new Response("Error", { status: 500 })
      }
      return new Response("<html><head><title>Success Title</title></head></html>", { status: 200 })
    }

    const results = await Effect.runPromise(
      scrapeAll(["https://ok.com", "https://fail.com"], mockFetch as unknown as typeof fetch)
    )

    expect(results).toHaveLength(2)
    expect(results[0]._tag).toBe("Success")
    if (results[0]._tag === "Success") {
      expect(results[0].data.title).toBe("Success Title")
    }
    expect(results[1]._tag).toBe("Failure")
    if (results[1]._tag === "Failure") {
      expect(results[1].url).toBe("https://fail.com")
      expect(results[1].reason).toContain("HTTP 500")
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/LinkPreviewEngine.test.ts`
Expected: FAIL ("Cannot find module '../src/LinkPreview.ts'")

- [ ] **Step 3: Implement `src/LinkPreview.ts` extraction and scraping**

Implement `extractUrls`, `scrapeMetadata`, `scrapeAll` using `get-urls`, `metascraper`, and plugins:
- Use `getUrls(text, { requireSchemeOrWww: true, stripWWW: false })`
- Filter only `url.startsWith("http://") || url.startsWith("https://")`
- Deduplicate into ordered array
- In `scrapeMetadata`:
  - `fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ..." }, signal: AbortSignal.timeout(10000) })`
  - Check `response.ok`; if not, fail with `HTTP ${response.status}`
  - Parse metadata with `createMetascraper([metascraperTitle(), metascraperDescription(), metascraperImage()])`
  - Normalize empty strings or whitespace to `undefined`
- In `scrapeAll`:
  - Map each URL to `scrapeMetadata`
  - Wrap in `Effect.match` to yield `ScrapingResult`
  - Execute via `Effect.all(effects, { concurrency: "unbounded" })`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/LinkPreviewEngine.test.ts`
Expected: PASS (all 7 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/LinkPreview.ts test/LinkPreviewEngine.test.ts
git commit -m "link-preview: Add URL extraction and metadata scraping engine"
```

---

### Task 3: Message Formatting & Output Builder

**Files:**
- Modify: `src/LinkPreview.ts`
- Test: `test/LinkPreviewFormat.test.ts`

**Interfaces:**
- Consumes: `src/TextWidth.ts`, `ScrapingResult`, `PageMetadata`
- Produces:
  ```ts
  export interface FormattedPreview {
    readonly text: string
    readonly image?: string
  }

  export function formatPreview(
    results: ReadonlyArray<ScrapingResult>
  ): FormattedPreview | null
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/LinkPreviewFormat.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import { formatPreview, type ScrapingResult } from "../src/LinkPreview.ts"

describe("formatPreview", () => {
  it("returns null when all results are failures", () => {
    const results: ScrapingResult[] = [
      { _tag: "Failure", url: "https://a.com", reason: "HTTP 404" },
      { _tag: "Failure", url: "https://b.com", reason: "Timeout" }
    ]
    expect(formatPreview(results)).toBeNull()
  })

  it("formats single successful URL with all metadata", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          title: "My Title",
          description: "My Description",
          image: "https://example.com/pic.jpg"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted).toEqual({
      text: "My Title\nMy Description",
      image: "https://example.com/pic.jpg"
    })
  })

  it("formats single successful URL with missing title as （无标题）", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          description: "My Description"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted).toEqual({
      text: "（无标题）\nMy Description",
      image: undefined
    })
  })

  it("formats single successful URL omitting description when missing", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          title: "Just Title"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted).toEqual({
      text: "Just Title",
      image: undefined
    })
  })

  it("formats multiple URLs with numbering, picking only the first image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://first.com",
          title: "First Title",
          description: "First Desc",
          image: "https://first.com/img1.png"
        }
      },
      {
        _tag: "Success",
        data: {
          url: "https://second.com",
          title: "Second Title",
          description: "Second Desc",
          image: "https://second.com/img2.png"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted).toEqual({
      text: "1. First Title\nFirst Desc\n2. Second Title\nSecond Desc",
      image: "https://first.com/img1.png"
    })
  })

  it("formats multi-link with partial failures and picks first available image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://fail.com",
        reason: "HTTP 404"
      },
      {
        _tag: "Success",
        data: {
          url: "https://has-img.com",
          title: "Success Title",
          image: "https://has-img.com/img.png"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted).toEqual({
      text: "1. [提取失败：HTTP 404]\n2. Success Title",
      image: "https://has-img.com/img.png"
    })
  })

  it("truncates long titles and descriptions in multi-link output", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://long.com",
          title: "中".repeat(60),
          description: "a".repeat(120)
        }
      },
      {
        _tag: "Success",
        data: {
          url: "https://short.com",
          title: "Short"
        }
      }
    ]
    const formatted = formatPreview(results)
    expect(formatted?.text).toContain("1. " + "中".repeat(48) + "...")
    expect(formatted?.text).toContain("a".repeat(97) + "...")
    expect(formatted?.text).toContain("2. Short")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/LinkPreviewFormat.test.ts`
Expected: FAIL ("formatPreview is not defined")

- [ ] **Step 3: Implement `formatPreview` in `src/LinkPreview.ts`**

Add `formatPreview` implementation:
- Check if all results are `_tag: "Failure"`; return `null` if so.
- If `results.length === 1` and `results[0]._tag === "Success"`:
  - Text lines: `truncate(item.data.title ?? "（无标题）")`
  - If `item.data.description`: push `truncate(item.data.description)`
  - Return `{ text: lines.join("\n"), image: item.data.image }`
- Otherwise (multiple items, or single failure with multiple items):
  - Map each item to numbered block:
    - If `_tag: "Failure"`: `${index}. [提取失败：${item.reason}]`
    - If `_tag: "Success"`:
      `${index}. ${truncate(item.data.title ?? "（无标题）")}`
      (if description, append `\n${truncate(item.data.description)}`)
  - Pick first available image: `results.find((r) => r._tag === "Success" && r.data.image)?._tag === "Success" ? ... : undefined`
  - Return `{ text: blocks.join("\n"), image: firstImage }`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/LinkPreviewFormat.test.ts`
Expected: PASS (all 7 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/LinkPreview.ts test/LinkPreviewFormat.test.ts
git commit -m "link-preview: Implement preview message formatting"
```

---

### Task 4: Incoming Message Handler & Bot Integration

**Files:**
- Modify: `src/LinkPreview.ts` (export `handleLinkPreviewMessage`)
- Modify: `src/index.ts` (combine handlers)
- Test: `test/LinkPreviewBot.test.ts`

**Interfaces:**
- Consumes: `IncomingMessage`, `SnowLumaClient`, `formatPreview`, `scrapeAll`, `extractUrls`
- Produces:
  ```ts
  export function handleLinkPreviewMessage(
    item: IncomingMessage,
    fetchFn?: typeof fetch
  ): Effect.Effect<void, never>
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/LinkPreviewBot.test.ts`:
```ts
import { describe, expect, it } from "bun:test"
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk"
import type { OneBotMessageEvent } from "@snowluma/sdk/types"
import { Effect } from "effect"
import { handleLinkPreviewMessage } from "../src/LinkPreview.ts"
import type { IncomingMessage } from "../src/SnowLuma.ts"

describe("handleLinkPreviewMessage", () => {
  it("quotes reply when message contains valid link", async () => {
    let quotedMessage: unknown = null
    const item: IncomingMessage = {
      event: {
        raw_message: "Please see https://example.com/test",
        message_type: "group",
        user_id: 10001,
        self_id: 99999,
        post_type: "message"
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async (msg: unknown) => {
          quotedMessage = msg
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    const mockFetch = async () =>
      new Response(
        "<html><head><title>Preview Title</title><meta name=\"description\" content=\"Preview Desc\"></head></html>",
        { status: 200 }
      )

    await Effect.runPromise(handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch))

    expect(quotedMessage).toBeDefined()
  })

  it("ignores self messages", async () => {
    let quoted = false
    const item: IncomingMessage = {
      event: {
        raw_message: "https://example.com",
        user_id: 99999,
        self_id: 99999,
        post_type: "message"
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleLinkPreviewMessage(item))
    expect(quoted).toBe(false)
  })

  it("ignores messages with message_sent post_type", async () => {
    let quoted = false
    const item: IncomingMessage = {
      event: {
        raw_message: "https://example.com",
        user_id: 10001,
        self_id: 99999,
        post_type: "message_sent"
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleLinkPreviewMessage(item))
    expect(quoted).toBe(false)
  })

  it("ignores messages without links", async () => {
    let quoted = false
    const item: IncomingMessage = {
      event: {
        raw_message: "Hello world without any link",
        user_id: 10001,
        self_id: 99999,
        post_type: "message"
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleLinkPreviewMessage(item))
    expect(quoted).toBe(false)
  })

  it("remains silent when all links fail to scrape", async () => {
    let quoted = false
    const item: IncomingMessage = {
      event: {
        raw_message: "https://fail.com/404",
        user_id: 10001,
        self_id: 99999,
        post_type: "message"
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    const mockFetch = async () => new Response("Not Found", { status: 404 })
    await Effect.runPromise(handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch))
    expect(quoted).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/LinkPreviewBot.test.ts`
Expected: FAIL ("handleLinkPreviewMessage is not defined")

- [ ] **Step 3: Implement `handleLinkPreviewMessage` and update `src/index.ts`**

In `src/LinkPreview.ts`:
- Check guard:
  ```ts
  if (
    event.post_type === "message_sent" ||
    event.user_id === event.self_id ||
    !event.raw_message
  ) {
    return Effect.void
  }
  ```
- Extract URLs: `const urls = extractUrls(event.raw_message)`
- If `urls.length === 0`: return `Effect.void`
- Scrape: `const results = yield* scrapeAll(urls, fetchFn)`
- Format: `const formatted = formatPreview(results)`
- If `!formatted`: return `Effect.void`
- Build message segment:
  ```ts
  const outgoing = formatted.image
    ? [segments.text(formatted.text + (formatted.text ? "\n" : "")), segments.image(formatted.image)]
    : segments.text(formatted.text)
  ```
- Send quote:
  ```ts
  yield* Effect.tryPromise(() => item.context.quote(outgoing))
  ```
- Catch and log errors with `Effect.catch`.

In `src/index.ts`:
- Import `handleLinkPreviewMessage` from `./LinkPreview.ts`
- Dispatch both handlers concurrently on each incoming message:
  ```ts
  const MainProgram = Effect.gen(function*() {
    const { messages } = yield* SnowLumaClient
    yield* Effect.logInfo("Sakurako bot listening for messages...")
    yield* messages.pipe(
      Stream.runForEach((item) =>
        Effect.all([handleIncomingMessage(item), handleLinkPreviewMessage(item)], {
          concurrency: "unbounded"
        }).pipe(Effect.asVoid)
      )
    )
  })
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/LinkPreviewBot.test.ts`
Expected: PASS (all 5 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/LinkPreview.ts src/index.ts test/LinkPreviewBot.test.ts
git commit -m "link-preview: Integrate link preview handler with bot message stream"
```

---

### Task 5: QA Verification, Linting & Full Test Suite

**Files:**
- Modify: `package.json` / `bun.lock` (if needed)

- [ ] **Step 1: Run type checking**

Run: `bun run check`
Expected: PASS (`tsc` finishes with 0 errors)

- [ ] **Step 2: Run linter**

Run: `bun run lint`
Expected: PASS (`oxlint` finishes with 0 errors)

- [ ] **Step 3: Run all test suites**

Run: `bun test`
Expected: PASS (all tests in `test/` pass)

- [ ] **Step 4: Verify smoke run**

Run: `bun -e 'import "./src/index.ts"'` with mock or check dry-run startup.

- [ ] **Step 5: Final commit**

```bash
git add package.json bun.lock
git commit -m "deps: Add get-urls and metascraper with re2 override"
```
