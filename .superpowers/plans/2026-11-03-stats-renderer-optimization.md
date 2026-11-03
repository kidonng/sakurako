# StatsRenderer Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize `StatsRenderer` using Satori and Sharp best practices: global font descriptor caching, `pointScaleFactor: 2` high-DPI grid alignment, OpenType tabular figures (`tnum`), `onStyleError` style protection, tuned Sharp PNG compression, flex/grid long-text resilience (`minWidth: 0`), CSS Grid column alignment, and declarative `satori/jsx` template structure.

**Architecture:** Refactor `src/features/stats/StatsRenderer.ts` to `src/features/stats/StatsRenderer.tsx` using Satori's built-in zero-dependency JSX runtime (`satori/jsx`). Hoist font descriptor initialization to the layer scope for HarfBuzz instance cache reuse across renders. Adopt CSS Grid for leaderboard headers and rows with tabular numbers for vertical alignment. Pass `pointScaleFactor: 2` and `onStyleError` to `satori()`, and configure `sharp().png({ compressionLevel: 6, effort: 4 })`.

**Tech Stack:** Bun 1.4.4, TypeScript 7, Effect 4, `satori` 0.63.2 (`satori/jsx`), `sharp` 0.35.5, `bun:test`.

**Spec:** User consultation based on `https://raw.githubusercontent.com/vercel/satori/refs/heads/main/README.md` and `@src/features/stats/StatsRenderer.ts`.

## Global Constraints

- Pinned runtime: Bun 1.4.4; no Node.js runtime.
- Strictly adhere to `allowImportingTsExtensions: true` with `.tsx` extensions for local imports of `.tsx` files.
- No `any` or `as any`.
- Maintain Effect 4 idioms (`Effect.gen`, `Effect.tryPromise`, `Context.Service`, `Layer.effect`).
- All tests must pass: `bun test`, `bun run check`, `bun run lint`, `bun run knip`.
- Linux kernel commit message format required.

## Review Focus

1. **Retina scaling dimensions**: Output image dimensions must remain 1240px wide (`620 * 144 / 72`) matching existing test expectations and sharpness.
2. **Font cache hit**: Layer initialization must read font data once, instantiate the Satori font descriptor array once, and reuse it across all `renderLeaderboard` calls.
3. **Ellipsis clipping**: Extremely long user nicknames must truncate with ellipsis without pushing or overlapping adjacent metric columns.
4. **CSS Grid alignment**: Header labels and row values must maintain identical column widths (`40px 1fr 80px 65px 65px 65px`) with `columnGap: 8px`.
5. **Style error resilience**: Unsupported or invalid CSS properties must be captured by `onStyleError` without causing the Effect to fail or reject.

---

### Task 1: Refactor StatsRenderer to JSX and Apply Satori & Sharp Optimizations

**Files:**
- Rename & Modify: `src/features/stats/StatsRenderer.ts` -> `src/features/stats/StatsRenderer.tsx`
- Modify: `src/index.ts:16`
- Modify: `src/features/stats/StatsCommand.ts:8`
- Modify: `test/features/stats/StatsRenderer.test.ts:7`
- Modify: `test/features/stats/StatsCommand.test.ts:7`
- Modify: `test/features/stats/StatsIntegration.test.ts:16`
- Update: `AGENTS.md` (references to `StatsRenderer.tsx`)

**Interfaces:**
- Consumes: `satori`, `sharp`, `LeaderboardResult`, `RenderLeaderboardOptions`
- Produces:
  ```tsx
  export interface RenderLeaderboardOptions {
    readonly groupName?: string;
    readonly timeLabel: string;
    readonly data: LeaderboardResult;
  }

  export class RenderError extends Schema.TaggedError<
    RenderError,
    { readonly brand: unique symbol }
  >()("RenderError", {
    message: Schema.String,
  }) {}

  export class StatsRenderer extends Context.Service<
    StatsRenderer,
    {
      readonly renderLeaderboard: (
        options: RenderLeaderboardOptions,
      ) => Effect.Effect<Buffer, RenderError>;
    }
  >()("sakurako/StatsRenderer") {
    static readonly layer: Layer.Layer<StatsRenderer>;
  }
  ```

- [ ] **Step 1: Write additional test cases for long nickname truncation and style error handling**

In `test/features/stats/StatsRenderer.test.ts`, add:
- A test verifying that long nicknames render successfully and generate valid PNG output.
- A test asserting that `pointScaleFactor: 2` and retina density 144 result in 1240px width.

- [ ] **Step 2: Rename `StatsRenderer.ts` to `StatsRenderer.tsx` and update imports**

Run `git mv src/features/stats/StatsRenderer.ts src/features/stats/StatsRenderer.tsx`.
Update import paths across:
- `src/index.ts`
- `src/features/stats/StatsCommand.ts`
- `test/features/stats/StatsRenderer.test.ts`
- `test/features/stats/StatsCommand.test.ts`
- `test/features/stats/StatsIntegration.test.ts`
- `AGENTS.md`

- [ ] **Step 3: Implement optimized `StatsRenderer.tsx`**

1. Add JSX pragmas at the top:
   ```tsx
   /** @jsxRuntime automatic */
   /** @jsxImportSource satori/jsx */
   ```
2. Define static style objects outside generator (`GRID_ROW_STYLE`, `NUMERIC_COL_STYLE`).
3. In `StatsRenderer.layer`, load `fontData` once and create `satoriFonts` array once:
   ```tsx
   const satoriFonts = [
     {
       name: "MiSans",
       data: fontData,
       weight: 400,
       style: "normal",
     },
   ] as const;
   ```
4. Build declarative JSX structure using CSS Grid (`gridTemplateColumns: "40px 1fr 80px 65px 65px 65px"`, `columnGap: 8`).
5. Apply OpenType tabular figures `fontFeatureSettings: '"tnum" 1'` on numeric columns.
6. Add `minWidth: 0, paddingRight: 4` on the nickname column with `overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"`.
7. Call `satori(jsx, { width: 620, pointScaleFactor: 2, fonts: satoriFonts, onStyleError: (e) => ... })`.
8. Rasterize with `sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 6, effort: 4 }).toBuffer()`.

- [ ] **Step 4: Run test suite and linters to verify**

Run:
```bash
bun test
bun run check
bun run lint
bun run knip
```
Expected: All pass with 0 errors.

- [ ] **Step 5: Commit changes**

```bash
git add src/ test/ AGENTS.md
git commit -m "perf(stats): optimize StatsRenderer with Satori best practices

### Problem

StatsRenderer hand-crafted 280 lines of verbose VDOM JSON objects,
recreated font descriptor objects on every render causing HarfBuzz font
cache misses in Satori, lacked subpixel pixel grid rounding for 2x
density scaling, did not enable tabular figures for vertical number
alignment, and missed error guards for unsupported CSS.

### Solution

- Adopt Satori built-in JSX runtime (\`satori/jsx\`) for clean declarative
  rendering templates.
- Define font descriptor in layer scope to enable Satori's internal
  HarfBuzz font instance caching.
- Use CSS Grid layout with unified column widths for header and rows.
- Enable OpenType tabular numbers (\`tnum\`) for numeric data alignment.
- Configure \`pointScaleFactor: 2\` for 2x Retina grid alignment.
- Add \`onStyleError\` handler to prevent crashes on unsupported CSS.
- Add \`minWidth: 0\` and right padding to prevent long nickname collisions.
- Tune Sharp PNG rasterization with compression level 6 and effort 4.

### References

- Satori documentation and issue #590 (font caching)
- .superpowers/plans/2026-11-03-stats-renderer-optimization.md"
```
