# 链接预览缺失描述时正文首段回落实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当网页缺失标准描述元数据时，使用语义过滤提取正文首个有效段落作为描述回落，并在格式化预览时应用宽度截断。

**Architecture:** 在 `src/LinkPreview.ts` 中实现纯函数 `extractFirstParagraph` 与 `firstParagraphPlugin`，将其置于 `createMetascraper` 的插件链末尾。利用 Cheerio DOM 优先检索语义主体容器（`article p`、`main p`、`[role="main"] p`），随后回落到通用 `p`，同时自动跳过包含在噪音容器（`header`、`footer`、`nav`、`aside`、`form`、`dialog`）中的段落并压平空白。

**Tech Stack:** TypeScript, Bun, Effect 4, `@snowluma/sdk`, `metascraper`, `cheerio`, `bun:test`

**Spec:** `.superpowers/specs/2026-10-28-first-paragraph-fallback-design.md`

## Global Constraints

- 遵循 Linux Kernel 风格提交信息规范（scope: Short imperative summary + Problem + Solution + References）。
- 严格遵循 `verbatimModuleSyntax: true` 与禁止 `any` 的类型安全要求。
- 相对模块导入必须携带 `.ts` 扩展名（如 `import ... from "./LinkPreviewSites.ts"`）。
- 不引入重复的 Cheerio DOM 解析开销，复用 metascraper 提供的 `htmlDom`。
- 回落的文本必须在 `formatPreview` 中保持应用现有的 `truncate`（120 宽度）规则。

## Review Focus

1. 祖先为噪音容器的段落（例如 `<article><aside><p>广告</p></aside><p>正文</p></article>`）：必须过滤噪音容器，提取正文段落。
2. 含有多余换行、制表符及连续空格的段落：必须清洗并折叠为单一空格并首尾 trim。
3. 纯空白或仅含 `&nbsp;` 的段落：必须视为空并跳过，继续寻找下一个有效段落。
4. 已有 `<meta name="description">` 或 `og:description` 的页面：必须由前置规则优先提取，不得被首段回落覆盖。
5. 全文无段落或所有段落均在噪音容器中的页面：必须优雅返回 `undefined`，不得抛出异常或输出空白描述行。

---

### Task 1: 实现并单测正文首段提取逻辑 (`extractFirstParagraph`)

**Files:**
- Modify: `src/LinkPreview.ts`
- Test: `test/LinkPreviewEngine.test.ts`

**Interfaces:**
- Produces: `export function extractFirstParagraph($: MetascraperRuleContext["htmlDom"]): string | undefined`
- Produces: `export function firstParagraphPlugin(): () => createMetascraper.Rules`

- [ ] **Step 1: 编写 `extractFirstParagraph` 的单元测试**

在 `test/LinkPreviewEngine.test.ts` 中添加一组针对 `extractFirstParagraph` 的测试用例，覆盖：
- 优先选择 `article p` / `main p` 而非普通 `p`。
- 排除 `header`、`footer`、`nav`、`aside`、`form`、`dialog` 内的段落。
- 跳过纯空白/`&nbsp;` 段落并提取下一个有效段落。
- 折叠连续空白符与换行符。
- 无有效段落时返回 `undefined`。

```ts
import { extractFirstParagraph } from "../src/LinkPreview.ts";
import * as cheerio from "cheerio";

describe("extractFirstParagraph", () => {
  it("prioritizes semantic containers over generic p", () => {
    const $ = cheerio.load(`
      <body>
        <p>Generic intro</p>
        <article><p>Article main content</p></article>
      </body>
    `);
    expect(extractFirstParagraph($)).toBe("Article main content");
  });

  it("ignores paragraphs inside noise containers", () => {
    const $ = cheerio.load(`
      <body>
        <header><p>Header notice</p></header>
        <nav><p>Nav links</p></nav>
        <article>
          <aside><p>Sidebar note</p></aside>
          <p>Real article paragraph.</p>
        </article>
        <footer><p>Footer copyright</p></footer>
      </body>
    `);
    expect(extractFirstParagraph($)).toBe("Real article paragraph.");
  });

  it("skips empty and whitespace-only paragraphs", () => {
    const $ = cheerio.load(`
      <body>
        <p></p>
        <p>   \n\t  </p>
        <p>&nbsp;</p>
        <p>First valid text.</p>
      </body>
    `);
    expect(extractFirstParagraph($)).toBe("First valid text.");
  });

  it("collapses multiple whitespaces and newlines", () => {
    const $ = cheerio.load(`
      <main>
        <p>
          Hello\n\n   world! \t This is
          Sakurako.
        </p>
      </main>
    `);
    expect(extractFirstParagraph($)).toBe("Hello world! This is Sakurako.");
  });

  it("returns undefined when no valid paragraph exists", () => {
    const $ = cheerio.load(`
      <body>
        <header><p>Only header</p></header>
      </body>
    `);
    expect(extractFirstParagraph($)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/LinkPreviewEngine.test.ts`
预期：FAIL，报错提示 `extractFirstParagraph` 未导出或未定义。

- [ ] **Step 3: 在 `src/LinkPreview.ts` 中实现 `extractFirstParagraph` 与 `firstParagraphPlugin`**

```ts
const NOISE_CONTAINERS = "header, footer, nav, aside, form, dialog";

export function extractFirstParagraph(
  $: MetascraperRuleContext["htmlDom"],
): string | undefined {
  const findIn = (selector: string): string | undefined => {
    for (const el of $(selector).toArray()) {
      const $el = $(el);
      if ($el.closest(NOISE_CONTAINERS).length > 0) {
        continue;
      }
      const text = $el.text().replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        return text;
      }
    }
    return undefined;
  };

  return (
    findIn("article p, main p, [role=\"main\"] p") ??
    findIn("p")
  );
}

export function firstParagraphPlugin(): () => createMetascraper.Rules {
  return () => ({
    description: [
      ({ htmlDom }: MetascraperRuleContext) => extractFirstParagraph(htmlDom),
    ],
  });
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test test/LinkPreviewEngine.test.ts`
预期：PASS，所有新增的段落提取单测全部通过。

- [ ] **Step 5: 提交更改**

```bash
git add src/LinkPreview.ts test/LinkPreviewEngine.test.ts
git commit -m "link-preview: Add first paragraph fallback extractor

### Problem

Web pages without meta descriptions or OpenGraph tags display without a
summary in link preview replies.

### Solution

Implement extractFirstParagraph to inspect semantic body containers
(article, main) with noise tag filtering (header, footer, nav, aside)
and whitespace collapse. Wrap in firstParagraphPlugin for metascraper.

### References

.superpowers/specs/2026-10-28-first-paragraph-fallback-design.md"
```

---

### Task 2: 集成至 Metascraper 插件链并验证端到端表现

**Files:**
- Modify: `src/LinkPreview.ts:19-24`
- Test: `test/LinkPreviewEngine.test.ts`

**Interfaces:**
- Consumes: `firstParagraphPlugin` from Task 1

- [ ] **Step 1: 编写集成测试用例**

在 `test/LinkPreviewEngine.test.ts` 中添加端到端抓取与元数据回落测试：
- 当没有 meta description 时，`scrapeMetadata` 成功回落到首个段落。
- 当已有 `<meta name="description">` 时，保持 meta 优先，不被段落覆盖。
- 当包含超长段落时，验证在 `formatPreview` 中被正确截断。

```ts
it("falls back to first paragraph when description metadata is missing", async () => {
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>No Description Page</title></head>
      <body>
        <nav><p>Menu</p></nav>
        <article>
          <p>This is the first real paragraph of the page content.</p>
        </article>
      </body>
    </html>
  `;
  const mockFetch = async () => new Response(mockHtml, { status: 200 });
  const result = await Effect.runPromise(
    scrapeMetadata(
      "https://example.com/no-desc",
      mockFetch as unknown as typeof fetch,
    ),
  );

  expect(result.title).toBe("No Description Page");
  expect(result.description).toBe("This is the first real paragraph of the page content.");
});

it("prefers meta description over first paragraph fallback", async () => {
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Meta Priority</title>
        <meta name="description" content="Official meta description">
      </head>
      <body>
        <main><p>Body paragraph content.</p></main>
      </body>
    </html>
  `;
  const mockFetch = async () => new Response(mockHtml, { status: 200 });
  const result = await Effect.runPromise(
    scrapeMetadata(
      "https://example.com/meta-priority",
      mockFetch as unknown as typeof fetch,
    ),
  );

  expect(result.description).toBe("Official meta description");
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/LinkPreviewEngine.test.ts`
预期：FAIL，`result.description` 为 `undefined`（因 `firstParagraphPlugin` 尚未接入 `createMetascraper`）。

- [ ] **Step 3: 在 `src/LinkPreview.ts` 中注册 `firstParagraphPlugin()`**

将 `firstParagraphPlugin()` 置于 `metascraperDescription()` 之后：

```ts
const scraper = createMetascraper([
  siteMetascraperPlugin(),
  metascraperTitle(),
  metascraperDescription(),
  firstParagraphPlugin(),
  metascraperImage(),
]);
```

- [ ] **Step 4: 运行全部测试与代码检查**

运行：
1. `bun test`
2. `bun run check`
3. `bun run lint`

预期：所有测试全部 PASS，类型检查无错误，oxlint 检查无告警。

- [ ] **Step 5: 提交更改**

```bash
git add src/LinkPreview.ts test/LinkPreviewEngine.test.ts
git commit -m "link-preview: Wire first paragraph fallback into metascraper pipeline

### Problem

Scraper does not utilize paragraph fallback when metadata tags are missing.

### Solution

Register firstParagraphPlugin in the metascraper chain immediately after
metascraperDescription to seamlessly provide fallback text for pages lacking
meta description tags.

### References

.superpowers/specs/2026-10-28-first-paragraph-fallback-design.md"
```
