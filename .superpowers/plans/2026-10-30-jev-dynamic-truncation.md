# Jev 双重 Noul 门控动态截断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为链接预览引入 Jev 双重 Noul 门控，在过滤无实质增量预览的同时，对增量信息在后段的预览动态放宽截断限制（从 100 宽度扩展至 280 宽度），避免关键信息被丢弃。

**Architecture:** 扩展 `ScrapingResult` 的 `Success` 增加 `expanded?: boolean`；`JevFilter` 向 System One 并发发起整体实质性（`has_substantive_info`）与标准截断充分性（`standard_is_sufficient`）两道 Noul 判定；`formatPreview` 依据 `expanded` 标记动态采用扩展截断宽度渲染 Description。

**Tech Stack:** TypeScript, Bun, Effect 4 (`effect`, `effect/http`), OpenRouter System One API (`~typesafe/jev-latest`).

**Spec:** `.superpowers/specs/2026-10-30-jev-dynamic-truncation-design.md`

## Global Constraints

- 遵循既有代码规范与 Effect 4 最佳实践（`verbatimModuleSyntax: true`，禁止 `any` 或 `as any`）。
- 本地相对路径导入必须保留 `.ts` 扩展名。
- HTTP 测试严禁 mock 全局 `fetch`，统一使用 `test/TestHttpClient.ts` 中的 `makeTestHttpClient`。
- Commit 信息遵循 Linux Kernel 规范（scope, Problem, Solution, References）。

## Review Focus

1. **短文本边界**：当 Description 长度本身小于等于 100 宽度时，无需提问 `standard_is_sufficient`，且 `expanded` 保持为 `false`。
2. **容错与 Fail-Open**：当 OpenRouter API 发生超时、500 或网络错误时，优雅回退至原始未扩展结果，不中断消息流程。
3. **Question 命名与多条目对应**：针对多条链接预览时，各条链接独立生成 `preview_${i}_has_substantive_info` 与 `preview_${i}_standard_is_sufficient`，结果映射不错位。
4. **缺失 Description 或自定义隐藏 Description**：当网页本身没有 Description 或 site customizer 指定了 `hideDescription: true` 时，不发出无意义的截断充分性判定。
5. **截断防刷屏**：即便是 `expanded: true`，依然受到 280 宽度的上限保护，防止恶意超长网页 SEO 堆砌污染群聊。

---

### Task 1: 扩展 `ScrapingResult` 与 `formatPreview` 支持动态截断宽度

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewBot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_DESCRIPTION_MAX_WIDTH = 100;
  export const EXPANDED_DESCRIPTION_MAX_WIDTH = 280;
  export type ScrapingResult =
    | {
        readonly _tag: "Success";
        readonly data: PageMetadata;
        readonly expanded?: boolean;
      }
    | {
        readonly _tag: "Filtered";
        readonly url: string;
      }
    | {
        readonly _tag: "Failure";
        readonly url: string;
        readonly error: ScrapeMetadataError;
      };
  ```

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/LinkPreviewBot.test.ts`**

Add tests to verify:
1. `formatPreview` uses `DEFAULT_DESCRIPTION_MAX_WIDTH` (100) when `expanded` is false or undefined.
2. `formatPreview` uses `EXPANDED_DESCRIPTION_MAX_WIDTH` (280) when `expanded` is true (both single link and multiple links).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: FAIL because `expanded` is not yet supported in `formatPreview`.

- [ ] **Step 3: Implement dynamic description width in `src/features/link-preview/LinkPreview.ts`**

1. Define `DEFAULT_DESCRIPTION_MAX_WIDTH = 100` and `EXPANDED_DESCRIPTION_MAX_WIDTH = 280`.
2. Update `ScrapingResult` union to include `readonly expanded?: boolean` on `_tag: "Success"`.
3. In `formatPreview`, determine `descMaxWidth = item.expanded ? EXPANDED_DESCRIPTION_MAX_WIDTH : DEFAULT_DESCRIPTION_MAX_WIDTH` when rendering `lines.push(`> ${truncate(rawDescription, descMaxWidth)}`)` and `block += `\n> ${truncate(rawDescription, descMaxWidth)}``.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewBot.test.ts
git commit -m "link-preview: support dynamic description truncation width in formatPreview"
```

---

### Task 2: 在 `JevFilter.ts` 中实现双重 Noul 门控与充分性判决

**Files:**
- Modify: `src/features/link-preview/JevFilter.ts`
- Test: `test/features/link-preview/JevFilter.test.ts`

**Interfaces:**
- Modifies: `filterPreviewResults` to ask both `has_substantive_info` and `standard_is_sufficient` when description is long, and output `expanded: true` when standard is insufficient.

- [ ] **Step 1: Write the failing tests in `test/features/link-preview/JevFilter.test.ts`**

Add unit tests:
1. When description exceeds 100 width, request payload includes `standard_truncated` and both `has_substantive_info` and `standard_is_sufficient` questions.
2. When `has_substantive_info >= 0.7` and `standard_is_sufficient < 0.7`, result has `_tag: "Success"` and `expanded: true`.
3. When `has_substantive_info >= 0.7` and `standard_is_sufficient >= 0.7`, result has `_tag: "Success"` and `expanded: false`.
4. When `has_substantive_info < 0.7`, result has `_tag: "Filtered"`.
5. When description width <= 100, `standard_is_sufficient` question is skipped and `expanded: false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/JevFilter.test.ts`
Expected: FAIL because dual questions and `expanded` decision are not yet implemented.

- [ ] **Step 3: Implement dual Noul evaluation in `src/features/link-preview/JevFilter.ts`**

1. Define questions instructions & criteria for `standard_is_sufficient`.
2. In `filterPreviewResults`, for each entry:
   - Compute `standardTruncated` using `truncate(entry.data.description, DEFAULT_DESCRIPTION_MAX_WIDTH)`.
   - Put `standard_truncated` in `previews[key]`.
   - Add `${key}_has_substantive_info` question.
   - If `entry.data.description` is present and `stringWidth(entry.data.description) > DEFAULT_DESCRIPTION_MAX_WIDTH`, also add `${key}_standard_is_sufficient` question.
3. Parse responses:
   - Check `substantiveScore >= threshold`. If false, set `_tag: "Filtered"`.
   - If true, check if `standard_is_sufficient` was asked:
     - If asked and score `< threshold`: set `_tag: "Success", data: item.data, expanded: true`.
     - Otherwise: set `_tag: "Success", data: item.data, expanded: false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/JevFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/JevFilter.ts test/features/link-preview/JevFilter.test.ts
git commit -m "link-preview: implement dual Noul gates for dynamic truncation in JevFilter"
```

---

### Task 3: 整体回归与真实用例验证

**Files:**
- All touched files

- [ ] **Step 1: Run type checker and linter**

Run: `bun run check && bun run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Verification against real IT Home message (Message ID: 882600025)**

Run an inline script with `bun` verifying:
1. Message `882600025` with OpenRouter API returns `expanded: true`.
2. `formatPreview` formats the preview with full tail information (including stablecoins and $3B freeze).
3. Completely redundant message returns `_tag: "Filtered"`.

- [ ] **Step 4: Commit and finalize**

```bash
git commit --allow-empty -m "link-preview: verify dual Noul dynamic truncation with live tests"
```
