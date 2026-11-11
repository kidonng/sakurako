# Link Preview Component-Level Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement fine-grained, component-level link preview filtering (Title, Description, and Image evaluated independently) to prevent partial content defects from silencing entire preview cards.

**Architecture:** Pre-filter hidden fields based on site customizers (`formatItem`); apply local heuristics in `DecisionHeuristics.ts` to fast-fail invalid titles and strip generic logo/icon images; invoke OpenRouter Decisions API only for surviving title validity and description incrementality; cascade-fail cards if title is invalid; drop auxiliary description if neither title nor image survives.

**Tech Stack:** TypeScript 7 (`verbatimModuleSyntax`, `allowImportingTsExtensions`), Effect 4, `@snowluma/sdk`, `bun:test`.

**Spec:** `.superpowers/specs/2026-11-11-link-preview-component-filtering-design.md`

## Global Constraints

- Module extensions: Always include `.ts` extensions in local relative imports.
- Types vs Values: Enforce `verbatimModuleSyntax: true` using `import type { ... }` or `import { type Foo, Bar } from "..."`.
- Schema Errors: Tagged errors require `{ readonly brand: unique symbol }` as second type parameter.
- No `any`: Never use `any` or `as any`.
- HTTP Mocking: Never mock global `fetch`; use `makeTestHttpClient` from `test/TestHttpClient.ts`.
- Text Truncation: Use `truncate` from `src/utils/TextWidth.ts`.
- Decision Thresholds: Title validity threshold is `0.3`; Description incrementality threshold is `0.7`.

## Review Focus

1. **Unhydrated SPA title (`"React App"`, `"Vite App"`) or error title (`"404 Not Found"`):** Cascade-fails the entire preview card to `ScrapingFiltered` without sending orphaned descriptions or images.
2. **Site customizer with `hideTitle: true` (e.g. GitHub single-link card):** Bypasses the title invalidity short-circuit and allows the image card to proceed and be sent.
3. **Site customizer with `hideDescription: true` (e.g. GitHub):** Does not generate or submit a description question to the Decisions API; sends the card without description.
4. **Valid title with generic boilerplate description (e.g. YouTube default slogan):** Strips the description while preserving the title and thumbnail image; replies with title + image.
5. **Generic logo/icon/avatar image URL:** Local heuristics immediately strip the image without network download or token cost; title and description are preserved.

---

### Task 1: Local Heuristic Filters (`DecisionHeuristics.ts`)

**Files:**
- Create: `src/features/link-preview/DecisionHeuristics.ts`
- Test: `test/features/link-preview/DecisionHeuristics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isInvalidTitle(title: string | undefined): boolean;
  export function isGenericIconUrl(url: string | undefined): boolean;
  ```

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/DecisionHeuristics.test.ts`**

```ts
import { describe, expect, it } from "bun:test";
import {
  isGenericIconUrl,
  isInvalidTitle,
} from "../../../src/features/link-preview/DecisionHeuristics.ts";

describe("DecisionHeuristics", () => {
  describe("isInvalidTitle", () => {
    it("flags empty, undefined, and whitespace-only titles as invalid", () => {
      expect(isInvalidTitle(undefined)).toBe(true);
      expect(isInvalidTitle("")).toBe(true);
      expect(isInvalidTitle("   \n\t ")).toBe(true);
    });

    it("flags generic SPA placeholders as invalid", () => {
      expect(isInvalidTitle("React App")).toBe(true);
      expect(isInvalidTitle("react app")).toBe(true);
      expect(isInvalidTitle("Vite App")).toBe(true);
      expect(isInvalidTitle("Create React App")).toBe(true);
      expect(isInvalidTitle("Loading...")).toBe(true);
      expect(isInvalidTitle("加载中...")).toBe(true);
      expect(isInvalidTitle("加载中")).toBe(true);
    });

    it("flags standard error status titles as invalid", () => {
      expect(isInvalidTitle("404 Not Found")).toBe(true);
      expect(isInvalidTitle("404")).toBe(true);
      expect(isInvalidTitle("403 Forbidden")).toBe(true);
      expect(isInvalidTitle("500 Internal Server Error")).toBe(true);
      expect(isInvalidTitle("Not Found")).toBe(true);
      expect(isInvalidTitle("Error")).toBe(true);
      expect(isInvalidTitle("页面未找到")).toBe(true);
      expect(isInvalidTitle("网页不存在")).toBe(true);
    });

    it("accepts legitimate content titles", () => {
      expect(isInvalidTitle("Bliss (Windows XP)")).toBe(false);
      expect(isInvalidTitle("GitHub - Effect-TS/effect")).toBe(false);
      expect(isInvalidTitle("Hello World - My Personal Blog")).toBe(false);
      expect(isInvalidTitle("404 Ways to Optimize React")).toBe(false);
    });
  });

  describe("isGenericIconUrl", () => {
    it("flags undefined or empty URLs as generic/invalid", () => {
      expect(isGenericIconUrl(undefined)).toBe(true);
      expect(isGenericIconUrl("")).toBe(true);
    });

    it("flags URLs with icon, logo, favicon, avatar, or chevron keywords", () => {
      expect(isGenericIconUrl("https://example.com/assets/logo.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/favicon.ico")).toBe(true);
      expect(isGenericIconUrl("https://example.com/static/user-avatar.jpg")).toBe(true);
      expect(isGenericIconUrl("https://example.com/images/nav-chevron.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/ui/arrow-right.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/spinner.gif")).toBe(true);
      expect(isGenericIconUrl("https://example.com/placeholder.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/icon-32x32.png")).toBe(true);
    });

    it("accepts legitimate content images", () => {
      expect(
        isGenericIconUrl(
          "https://i.ytimg.com/vi/AoNnbz237E0/maxresdefault.jpg",
        ),
      ).toBe(false);
      expect(
        isGenericIconUrl("https://example.com/uploads/2026/11/cover-photo.jpg"),
      ).toBe(false);
      expect(
        isGenericIconUrl("https://opengraph.githubassets.com/123/org/repo"),
      ).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/DecisionHeuristics.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `DecisionHeuristics.ts`**

Create `src/features/link-preview/DecisionHeuristics.ts`:
```ts
const INVALID_TITLE_PATTERNS = [
  /^(React App|Vite App|Create React App)$/i,
  /^(Loading(\.\.\.)?|加载中(\.\.\.)?)$/i,
  /^(404( Not Found)?|403( Forbidden)?|500( Internal Server Error)?|Not Found|Error)$/i,
  /^(页面未找到|网页不存在)$/i,
];

const GENERIC_ICON_PATTERNS = [
  /(^|[-_./])(logo|favicon|avatar|icon|chevron|arrow|spinner|placeholder)([-_./]|$)/i,
];

export function isInvalidTitle(title: string | undefined): boolean {
  if (!title) {
    return true;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return INVALID_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isGenericIconUrl(url: string | undefined): boolean {
  if (!url || url.trim().length === 0) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const pathAndQuery = `${parsed.pathname}${parsed.search}`;
    return GENERIC_ICON_PATTERNS.some((pattern) => pattern.test(pathAndQuery));
  } catch {
    return GENERIC_ICON_PATTERNS.some((pattern) => pattern.test(url));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/DecisionHeuristics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/DecisionHeuristics.ts test/features/link-preview/DecisionHeuristics.test.ts
git commit -m "link-preview: Add DecisionHeuristics for title and image fast filtering"
```

---

### Task 2: Refactor Decisions API and Component Decisions in `DecisionFilter.ts`

**Files:**
- Modify: `src/features/link-preview/DecisionFilter.ts`
- Test: `test/features/link-preview/DecisionFilter.test.ts`

**Interfaces:**
- Consumes:
  - `isInvalidTitle`, `isGenericIconUrl` from `./DecisionHeuristics.ts`
  - `ScrapingResult`, `PageMetadata`, `isScrapingResult`, `ScrapingFiltered` from `./LinkPreview.ts`
- Produces:
  ```ts
  export const filterPreviewResults: (
    rawMessage: string,
    results: ReadonlyArray<ScrapingResult>,
    apiKey?: Redacted.Redacted<string>,
    model?: string,
    threshold?: number,
    timeoutDuration?: Duration.Input,
    userImages?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write failing tests in `test/features/link-preview/DecisionFilter.test.ts` for component-level filtering**

Add tests covering:
1. Title cascade failure: When title score is `< 0.3`, returns `ScrapingFiltered`.
2. Title success + Description failure: When title score is `0.9` and description score is `0.2` (below 0.7), returns `ScrapingSuccess` with `title` preserved and `description: undefined`.
3. Absence of description in input: Does not generate `_description_has_substantive_info` question, preserves title and image.
4. Local generic icon stripping: Strips `image` matching `isGenericIconUrl` without asking Decisions API.
5. Minimum anchor rule: When title is rejected and image was rejected, card is filtered even if description scored high.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: FAIL on new component-level assertions.

- [ ] **Step 3: Update `DecisionFilter.ts` to implement component-level questions and cascading**

1. Introduce title question generator `makeTitleQuestion(key)`. Threshold for title is `DEFAULT_TITLE_THRESHOLD = 0.3`. Threshold for description is `DEFAULT_DESCRIPTION_THRESHOLD = 0.7`.
2. For each successful result:
   - Check `isInvalidTitle(item.data.title)`. If invalid and `item.data.title` was present, mark title as invalid.
   - Check `isGenericIconUrl(item.data.image)`. If true, set `candidateImage = undefined`.
   - If candidate title exists, generate `${key}_title_is_meaningful`.
   - If candidate description exists, generate `${key}_description_has_substantive_info` (and sufficiency question if long).
3. In response parsing:
   - Evaluate title: if title question was asked and score `< 0.3`, cascade drop to `ScrapingFiltered`.
   - Evaluate description: if description question was asked, retain description only if score `>= 0.7`.
   - If neither `title` nor `image` remains in the final item, mark as `ScrapingFiltered`.
   - Otherwise, update result with stripped fields (`title`, `description`, `image`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/DecisionFilter.ts test/features/link-preview/DecisionFilter.test.ts
git commit -m "link-preview: Refactor DecisionFilter for component-level decisions"
```

---

### Task 3: Effective Preview Extraction & Site Customizer Integration in `LinkPreview.ts`

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewBot.test.ts`
- Test: `test/features/link-preview/LinkPreviewFormat.test.ts`

**Interfaces:**
- Consumes:
  - `findSiteCustomizer` from `./LinkPreviewSites.ts`
  - `filterPreviewResults` from `./DecisionFilter.ts`
  - `isInvalidTitle`, `isGenericIconUrl` from `./DecisionHeuristics.ts`
- Produces:
  - `prepareEffectiveScrapingResults(results: ReadonlyArray<ScrapingResult>, isSingle: boolean): ReadonlyArray<ScrapingResult>`

- [ ] **Step 1: Write failing tests in `LinkPreviewFormat.test.ts` and `LinkPreviewBot.test.ts`**

1. In `LinkPreviewFormat.test.ts`: test formatting of a single link with title + image (no description), verifying it outputs `{ text: "Title", image: "https://example.com/pic.jpg" }`.
2. In `LinkPreviewBot.test.ts`: test GitHub link with `hideDescription: true`, verifying no description question is generated in the payload sent to Decisions API.
3. In `LinkPreviewBot.test.ts`: test YouTube URL with empty description and valid title + thumbnail, verifying it sends reply with `text: "Bliss (Windows XP)\n"` and thumbnail image segment.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: FAIL on the YouTube partial preview scenario.

- [ ] **Step 3: Implement effective preview preparation and integration in `LinkPreview.ts`**

1. Before invoking `filterPreviewResults`, transform results into effective metadata:
   - For each `ScrapingSuccess`, resolve `findSiteCustomizer(item.data.url)?.formatItem?.({ metadata: item.data, isSingle })`.
   - If `options?.hideTitle`, set `title = undefined`.
   - If `options?.hideDescription`, set `description = undefined`.
   - If `options?.hideImage`, set `image = undefined` and `fallbackImage = undefined`.
   - If `options?.title`, override `title = options.title`.
   - If `options?.description`, override `description = options.description`.
2. Pass effective results into `filterPreviewResults`.
3. In `formatPreview` / `formatOutgoingMessage`: ensure items with `title` but no `description` format cleanly (no empty `>` quotes), and single items with image format cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts test/features/link-preview/LinkPreviewFormat.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite and type check**

Run:
```bash
bun run check
bun run lint
bun test
```
Expected: PASS (0 errors, 0 lint warnings, all tests green).

- [ ] **Step 6: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewBot.test.ts test/features/link-preview/LinkPreviewFormat.test.ts
git commit -m "link-preview: Integrate effective preview extraction and customizer options"
```

---

## Plan Review & Self-Check

- [x] **Spec coverage:** All requirements from `.superpowers/specs/2026-11-11-link-preview-component-filtering-design.md` are mapped to Tasks 1–3.
- [x] **Step scan:** Every step contains explicit file paths, code signatures, test assertions, and shell commands.
- [x] **Type consistency:** Function signatures and parameter names (`isInvalidTitle`, `isGenericIconUrl`, `filterPreviewResults`) are uniform across all tasks.
- [x] **Review Focus:** All 5 focus points are covered with explicit automated test assertions in the corresponding tasks.
- [x] **Proportion:** The plan is focused on exact interfaces and step actions without repeating the entire spec prose.
