# SauceNao Source Filter & Candidate Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter SauceNao reverse image search to 15 high-freshness Japanese ACG databases using `dbs[]` query parameters and fetch 5 candidates with client-side origin-preferred selection.

**Architecture:** Export `TARGET_SAUCENAO_DBS` containing the 15 verified Japanese ACG databases. Query SauceNao with `dbs[]` query parameters and `numres=5`. In `searchSauce`, replace the single-result pickup with `selectBestSauceResult`: filter candidates by `minimum_similarity`, identify the highest similarity match, and if an original artist platform (Pixiv, Skeb, Nico Seiga, Nijie) is within 2.0% tolerance, prefer that original platform to return canonical author and source links.

**Tech Stack:** TypeScript 7 (`verbatimModuleSyntax`, `allowImportingTsExtensions`), Effect 4, `bun:test`.

**Spec:** `.superpowers/specs/2026-11-12-saucenao-source-filter-design.md`

## Global Constraints

- Module extensions: Always include `.ts` extensions in local relative imports.
- Types vs Values: Enforce `verbatimModuleSyntax: true` using `import type { ... }` or `import { type Foo, Bar } from "..."`.
- Schema Errors: Tagged errors require `{ readonly brand: unique symbol }` as second type parameter.
- No `any`: Never use `any` or `as any`.
- HTTP Mocking: Never mock global `fetch`; use `makeTestHttpClient` from `test/TestHttpClient.ts`.
- Linux Kernel Commit Style: Use imperative subject line, Problem/Solution/References sections.

## Review Focus

1. **Origin candidate within 2.0% of maximum similarity:** When a reupload/booru result has slightly higher similarity (e.g. 91.5%) than a Pixiv/Skeb origin result (e.g. 90.5%), the origin result is preferred.
2. **Origin candidate beyond 2.0% of maximum similarity:** When a reupload has a significantly higher match (e.g. Danbooru 95.0% vs Pixiv 70.0%), the higher-confidence match is selected.
3. **Missing `index_id` on result items:** Treated as non-origin index without crashing or dropping valid results.
4. **Missing `similarity` on result items:** Treated as 0 similarity (filtered out when below threshold).
5. **All candidates below `minimum_similarity`:** Correctly returns `null` without throwing.

---

### Task 1: URL Query Construction with Target DBs and `numres=5`

**Files:**
- Modify: `src/features/sauce/SauceNao.ts`
- Modify: `test/features/sauce/SauceNao.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TARGET_SAUCENAO_DBS: readonly number[];
  ```
- Consumes: `SAUCENAO_API_URL` in `src/features/sauce/SauceNao.ts`

- [ ] **Step 1: Write the failing tests in `test/features/sauce/SauceNao.test.ts`**

Update the existing `appends api_key query parameter when apiKey is provided` test and add a dedicated test verifying the URL parameters:

```ts
it("queries SauceNao with numres=5, no db=999, and dbs[] for all target databases", async () => {
  let requestedUrl = "";
  const mockResponse = {
    header: {
      status: 0,
      minimum_similarity: 60.0,
    },
    results: [
      {
        header: {
          similarity: "80.00",
          index_id: 5,
        },
        data: {
          title: "Test Image",
        },
      },
    ],
  };

  const layer = makeTestHttpClient((req) => {
    requestedUrl = req.url;
    return Response.json(mockResponse);
  });

  await Effect.runPromise(
    searchSauce(
      "https://example.com/pic.png",
      Redacted.make("secret_sauce_key"),
    ).pipe(Effect.provide(layer)),
  );

  const searchParams = new URL(requestedUrl).searchParams;
  expect(searchParams.get("api_key")).toBe("secret_sauce_key");
  expect(searchParams.get("output_type")).toBe("2");
  expect(searchParams.get("numres")).toBe("5");
  expect(searchParams.get("db")).toBeNull();
  expect(searchParams.get("url")).toBe("https://example.com/pic.png");
  expect(searchParams.getAll("dbs[]")).toEqual(
    TARGET_SAUCENAO_DBS.map(String),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: FAIL with `db=999` still present and `dbs[]` missing.

- [ ] **Step 3: Implement target databases and URL building in `src/features/sauce/SauceNao.ts`**

Define and export `TARGET_SAUCENAO_DBS`:
```ts
export const TARGET_SAUCENAO_DBS = [
  5,  // pixiv
  8,  // nico nico seiga
  9,  // danbooru
  11, // nijie
  12, // yande.re
  16, // FAKKU
  18, // H-Misc (nhentai)
  21, // Anime
  22, // H-Anime
  25, // Gelbooru
  26, // Konachan
  28, // Anime-Pictures
  37, // MangaDex
  38, // H-Misc (e-hentai)
  44, // Skeb
] as const;
```

Update `searchSauce` URL building:
```ts
const url = new URL(SAUCENAO_API_URL);
url.searchParams.set("output_type", "2");
url.searchParams.set("numres", "5");
url.searchParams.set("url", imageUrl);
for (const db of TARGET_SAUCENAO_DBS) {
  url.searchParams.append("dbs[]", String(db));
}
if (apiKey) {
  url.searchParams.set("api_key", Redacted.value(apiKey));
}

const request = HttpClientRequest.get(url.toString());
```

Also update the existing test in `test/features/sauce/SauceNao.test.ts` (the existing apiKey test) to assert `numres=5` and `searchParams.get("db") === null` instead of the legacy `db=999`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/sauce/SauceNao.ts test/features/sauce/SauceNao.test.ts
git commit -m "sauce: query specific anime databases with numres=5

### Problem

SauceNao search used db=999 and numres=1, querying all 40+ databases.
This introduced false positives from Western art, furry sites, and
abandoned/broken index sources, and prevented retrieving alternative
candidates when the top result was noisy.

### Solution

Limit queries to 15 verified Japanese ACG databases via dbs[] query
parameters and raise numres to 5.

### References

.superpowers/specs/2026-11-12-saucenao-source-filter-design.md"
```

---

### Task 2: Multi-Candidate Selection & Origin Platform Priority

**Files:**
- Modify: `src/features/sauce/SauceNao.ts`
- Modify: `test/features/sauce/SauceNao.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SauceResult {
    readonly title: string;
    readonly author?: string;
    readonly url?: string;
    readonly formattedText: string;
    readonly similarity: number;
  }
  export function selectBestSauceResult(
    results: readonly (typeof SauceNaoItemSchema.Type)[] | undefined,
    minSimilarity: number,
  ): typeof SauceNaoItemSchema.Type | null;
  ```
- Consumes: `SauceNaoItemSchema` in `src/features/sauce/SauceNao.ts`

- [ ] **Step 1: Write the failing tests in `test/features/sauce/SauceNao.test.ts`**

Add unit tests covering:
1. Prefers primary origin platform (Pixiv #5) over Danbooru (#9) when similarity is within 2.0% tolerance.
2. Prefers higher similarity candidate when difference exceeds 2.0% tolerance (e.g. Danbooru 95.0% vs Pixiv 70.0%).
3. Returns highest similarity candidate among non-origin platforms.
4. Returns `null` when all candidates have similarity < `minimum_similarity`.
5. Handles candidate items with missing `index_id` or missing `similarity` safely.

```ts
it("prefers primary origin platform (Pixiv) over booru when within 2.0% similarity tolerance", async () => {
  const mockResponse = {
    header: { status: 0, minimum_similarity: 60.0 },
    results: [
      {
        header: { similarity: "91.50", index_id: 9 }, // Danbooru
        data: { title: "Booru Reupload", ext_urls: ["https://danbooru.donmai.us/posts/1"] },
      },
      {
        header: { similarity: "90.20", index_id: 5 }, // Pixiv
        data: { title: "Original Art", member_name: "OriginalArtist", ext_urls: ["https://www.pixiv.net/artworks/1"] },
      },
    ],
  };

  const layer = makeTestHttpClient(() => Response.json(mockResponse));
  const result = await Effect.runPromise(
    searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
  );

  expect(result).not.toBeNull();
  expect(result?.title).toBe("Original Art");
  expect(result?.author).toBe("OriginalArtist");
  expect(result?.similarity).toBe(90.20);
});

it("prefers higher similarity match when difference exceeds 2.0% tolerance even if lower match is an origin platform", async () => {
  const mockResponse = {
    header: { status: 0, minimum_similarity: 60.0 },
    results: [
      {
        header: { similarity: "95.00", index_id: 9 }, // Danbooru
        data: { title: "Clear Match", ext_urls: ["https://danbooru.donmai.us/posts/2"] },
      },
      {
        header: { similarity: "75.00", index_id: 5 }, // Pixiv
        data: { title: "Low Confidence Pixiv", member_name: "SomeArtist", ext_urls: ["https://www.pixiv.net/artworks/2"] },
      },
    ],
  };

  const layer = makeTestHttpClient(() => Response.json(mockResponse));
  const result = await Effect.runPromise(
    searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
  );

  expect(result).not.toBeNull();
  expect(result?.title).toBe("Clear Match");
  expect(result?.similarity).toBe(95.00);
});

it("returns null when all candidates have similarity below minimum_similarity", async () => {
  const mockResponse = {
    header: { status: 0, minimum_similarity: 60.0 },
    results: [
      {
        header: { similarity: "58.00", index_id: 5 },
        data: { title: "Low similarity" },
      },
      {
        header: { similarity: "40.00", index_id: 9 },
        data: { title: "Even lower" },
      },
    ],
  };

  const layer = makeTestHttpClient(() => Response.json(mockResponse));
  const result = await Effect.runPromise(
    searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
  );

  expect(result).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: FAIL because `searchSauce` always takes `results[0]` regardless of origin priority or multiple candidates.

- [ ] **Step 3: Implement candidate selection logic in `src/features/sauce/SauceNao.ts`**

Define origin platforms and tolerance:
```ts
export const PRIMARY_ORIGIN_DBS = new Set([
  5,  // Pixiv
  8,  // Nico Nico Seiga
  11, // Nijie
  44, // Skeb
]);

export const SIMILARITY_ORIGIN_TOLERANCE = 2.0;

export function selectBestSauceResult(
  results: readonly (typeof SauceNaoItemSchema.Type)[] | undefined,
  minSimilarity: number,
): typeof SauceNaoItemSchema.Type | null {
  if (!results || results.length === 0) {
    return null;
  }

  // Filter candidates meeting minimum similarity
  const validCandidates = results.filter((item) => {
    const sim = item.header?.similarity ?? 0;
    return sim >= minSimilarity;
  });

  if (validCandidates.length === 0) {
    return null;
  }

  // Find candidate with maximum similarity
  let highestMatch = validCandidates[0]!;
  let maxSimilarity = highestMatch.header?.similarity ?? 0;

  for (let i = 1; i < validCandidates.length; i++) {
    const item = validCandidates[i]!;
    const sim = item.header?.similarity ?? 0;
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      highestMatch = item;
    }
  }

  // Check if an origin platform candidate exists within SIMILARITY_ORIGIN_TOLERANCE
  const cutoff = maxSimilarity - SIMILARITY_ORIGIN_TOLERANCE;
  let bestOriginCandidate: (typeof SauceNaoItemSchema.Type) | undefined;
  let bestOriginSimilarity = -1;

  for (const candidate of validCandidates) {
    const indexId = candidate.header?.index_id;
    const sim = candidate.header?.similarity ?? 0;
    if (
      indexId !== undefined &&
      PRIMARY_ORIGIN_DBS.has(indexId) &&
      sim >= cutoff
    ) {
      if (sim > bestOriginSimilarity) {
        bestOriginSimilarity = sim;
        bestOriginCandidate = candidate;
      }
    }
  }

  return bestOriginCandidate ?? highestMatch;
}
```

Wire `selectBestSauceResult` into `searchSauce`:
```ts
const minSimilarity = json.header?.minimum_similarity ?? 0;
const best = selectBestSauceResult(json.results, minSimilarity);
if (!best) {
  return null;
}

const similarity = best.header?.similarity ?? 0;
const data = best.data;
const title = extractTitle(data);
const author = extractAuthor(data);
const url = extractUrl(data);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/sauce/SauceNao.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/sauce/SauceNao.ts test/features/sauce/SauceNao.test.ts
git commit -m "sauce: prioritize primary origin platforms within similarity tolerance

### Problem

When multiple search results passed minimum similarity, the first
returned result was used unconditionally. If a booru reupload had a
negligibly higher similarity score due to image compression variations,
it crowded out the original Pixiv/Skeb post which contains canonical
author metadata and original links.

### Solution

Implement selectBestSauceResult to evaluate all returned candidates
against minimum similarity, find the top match, and prioritize primary
origin platforms (Pixiv, Skeb, Nico Seiga, Nijie) if their similarity is
within 2.0% of the top match.

### References

.superpowers/specs/2026-11-12-saucenao-source-filter-design.md"
```

---

### Task 3: Full Regression and Type/Lint Verification

**Files:**
- Test: all test suites

- [ ] **Step 1: Run complete test suite**

Run: `bun test`
Expected: PASS (all tests passing)

- [ ] **Step 2: Run type checking**

Run: `bun run check`
Expected: PASS (0 errors)

- [ ] **Step 3: Run linter and knip**

Run: `bun run lint && bun run knip`
Expected: PASS (0 warnings or errors)
