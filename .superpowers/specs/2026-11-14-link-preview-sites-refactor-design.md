# 链接预览站点定制接口重构设计 (Link Preview Sites Refactor Design)

## 目标与背景 (Intent & Why)

### 问题现状
当前 `src/features/link-preview/LinkPreviewSites.ts` 将三种不同生命周期的站点定制能力混杂在同一个 `SiteCustomizer` 接口中，导致职责边界模糊、类型冗余和重复计算：
1. **重复封装 `metascraper` 规则接口**：`SiteCustomizer.metascraperRules` 自定义了 `{ description?, title?, image?, fallbackImage? }` 包装结构，再通过 `siteMetascraperPlugin()` 在每个字段回调里重复调用 `findSiteCustomizer(url)`。这丢失了 `metascraper` 原生 `createMetascraper.Rules` 自带的 `test` 门控与 `pkgName` 调试元信息。
2. **规则内重复做宿主校验**：例如 `hackerNewsCustomizer.metascraperRules.description` 内部再次解析 URL 并校验 `news.ycombinator.com`，与 `match` 职责重叠。
3. **请求前抓取与展示裁剪耦合**：`danbooruCustomizer` 同时定义了 `scrape` 与 `formatItem`。虽然 `formatItem`（`hideDescription: true`）在非 `/posts/:id` 页面以及 `scrape` 因 429/超时/网络错误回退至 HTML 或 `FallbackScraper` 时依然必需，但将二者塞在同一接口中缺乏清晰的阶段语义。
4. **幽灵字段与重复求值**：`SiteFormatOptions` 声明了从未使用的 `title` / `description` 覆写字段；`LinkPreview.ts` 中 `prepareEffectiveScrapingResults` 与 `formatPreview` 累计在多处重复调用 `findSiteCustomizer` 与 `formatItem`。

### 核心目标
- **按阶段正交拆分**：将站点定制拆分为「自定义抓取（Scraper）」「HTML 提取规则（Metascraper Rules）」「展示裁剪策略（Display Policy）」三个互不耦合的注册表。
- **直接使用 `createMetascraper.Rules`**：消除 `siteMetascraperPlugin()` 包装层与重复 host 判断，利用 `metascraper` 原生 `test` 完成 URL 门控。
- **保留所有既有运行时行为**：包括 Danbooru 非帖子页及抓取失败回退 HTML 时的 `hideDescription` 语义、`pixiv.cat` 主图 + `fallbackImage` 机制、GitHub 单/多链接标题裁剪、HN 外链提取与去图。
- **收拢展示裁剪求值**：在 `LinkPreview.ts` 中由 `prepareEffectiveScrapingResults` 统一应用展示策略与 SVG 过滤，`formatPreview` 直接复用归一化结果。

### 非目标 (Non-Goals)
- 不改变任何站点的用户可见预览输出格式或 LLM 决策过滤逻辑。
- 不新增站点规则或改动 `FallbackScraper`、`DecisionFilter` 的外部契约。

---

## 方案对比 (Approaches Considered)

### 方案 A：按职责拆成三个正交注册表（已选定）
- 将 `LinkPreviewSites.ts` 拆为独立的 `siteScrapers`、`siteMetascraperRules`（原生 `createMetascraper.Rules[]`）和 `siteDisplayRules`。
- **优点**：每个阶段职责单一、无空洞字段、无需自造包装类型；Danbooru 的“API 直抓”与“HTML 回退去描述”分属两个独立阶段，语义清晰。
- **缺点**：同一站点若横跨多阶段（如 Hacker News 的提取规则与去图策略），会分别出现在对应阶段的注册表中。

### 方案 B：保留按站点聚拢的 `SiteRule` 对象
- 保留每站点一个导出对象，仅将内部字段替换为 `htmlRules`（注入 `test`）和纯裁剪 `display`。
- **未选原因**：仍需维护一层薄桥接将站点对象转换为 `createMetascraper.Rules`，且单个 `match` 往往难以同时表达“整站级显示裁剪”和“特定路径级提取/抓取”的粒度差异。

### 方案 C：完全打散为独立文件
- 为每个站点建单独文件。
- **未选原因**：当前仅有 4 个站点、总代码约 200 行，拆文件会增加不必要的目录碎片。

---

## 详细设计 (Architecture & Design)

### 1. 模块接口 (`src/features/link-preview/LinkPreviewSites.ts`)

#### 阶段一：请求前自定义抓取 (`SiteScraper`)
用于需要绕过常规 HTML 抓取、直接请求结构化 API 的特定路径（如 Danbooru 帖子页）：
```ts
export interface SiteScraper {
  readonly id: string;
  readonly match: (url: URL) => boolean;
  readonly scrape: (
    url: URL,
  ) => Effect.Effect<
    PageMetadata | undefined,
    HttpFetchError,
    HttpClient.HttpClient
  >;
}
```
- **`danbooruPostScraper`**：`match` 直接校验 `donmai.us`（含子域）且路径匹配 `/^\/posts\/(\d+)/`。`scrape` 直接请求 `${url.origin}/posts/${id}.json`，对 `HttpNoContentError` / `HttpRateLimitError` / `HttpTimeoutError` / `HttpNetworkError` 返回 `undefined` 以回退标准 HTML/Fallback 抓取。
- 导出 `scrapeWithSiteOverride(url: URL)`（或 `findSiteScraper(rawUrl)` + 对应执行函数）：若无命中 `match` 的 scraper 直接返回 `undefined`。

#### 阶段二：HTML 元数据提取规则 (`createMetascraper.Rules`)
直接导出原生 `createMetascraper.Rules`（使用 `satisfies createMetascraper.Rules` 保持精确字段类型以便单测）：
- **`hackerNewsRules`**：
  - `pkgName: "site:hacker-news"`
  - `test: ({ url }) => ...`：统一校验 `news.ycombinator.com`、`pathname === "/item"` 且存在 `id` 查询参数。
  - `description: ({ htmlDom, url }) => ...`：不再重复校验 hostname 与 `/item?id=`，专注从 `.titleline a` 提取合法外部 HTTP(S) 链接。
- **`pixivRules`**：
  - `pkgName: "site:pixiv"`
  - `test: ({ url }) => ...`：统一校验 `pixiv.net` / `*.pixiv.net` 且路径匹配 `/artworks/:id`。
  - `image: ({ url }) => ...`：映射为 `https://pixiv.cat/${id}.jpg`。
  - `fallbackImage: ({ htmlDom }) => ...`：从 `og:image` / `twitter:image` 提取备用图。
- 导出 `siteMetascraperRules: ReadonlyArray<createMetascraper.Rules> = [hackerNewsRules, pixivRules]`。

#### 阶段三：展示裁剪策略 (`SiteDisplayRule`)
仅保留实际使用的字段隐藏策略，移除未使用的 `title` / `description` 字符串覆写以及未使用的 `metadata` 参数：
```ts
export interface SiteDisplayPolicy {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
}

export interface SiteDisplayRule {
  readonly id: string;
  readonly match: (url: URL) => boolean;
  readonly getPolicy: (context: {
    readonly isSingle: boolean;
  }) => SiteDisplayPolicy;
}
```
- **`githubDisplayRule`**：匹配 `github.com`，返回 `{ hideDescription: true, hideTitle: isSingle }`。
- **`hackerNewsDisplayRule`**：匹配 `news.ycombinator.com`，返回 `{ hideImage: true }`。
- **`danbooruDisplayRule`**：匹配 `donmai.us`（含子域），返回 `{ hideDescription: true }`，覆盖非 `/posts/:id` 页面及 `scrape` 失败回退 HTML / `FallbackScraper` 后的所有 Danbooru 成功结果。
- 导出 `getSiteDisplayPolicy(rawUrl: string | URL, context: { readonly isSingle: boolean }): SiteDisplayPolicy | undefined`（及各规则常量供单测）。

### 2. 消费端整合 (`src/features/link-preview/LinkPreview.ts`)

1. **构建 `scraper`**：
   ```ts
   const scraper = createMetascraper([
     ...siteMetascraperRules,
     metascraperTitle(),
     metascraperDescription(),
     firstParagraphPlugin(),
     metascraperImage(),
   ]);
   ```
   `firstParagraphPlugin()` 同样直接返回 `createMetascraper.Rules`，移除不再需要的 `MetascraperRuleContext` 和 `siteMetascraperPlugin`。
2. **`scrapeMetadata(url)`**：
   直接调用 `scrapeWithSiteOverride(urlObj)`（若命中且返回有效 `PageMetadata` 则直接返回，返回 `undefined` 则走现有 `fetchText` + `FallbackScraper` 路径）。
3. **统一 `prepareEffectiveScrapingResults` 与 `formatPreview`**：
   - `prepareEffectiveScrapingResults(results, isSingle)` 使用 `getSiteDisplayPolicy(item.url, { isSingle })` 剔除被 `hide*` 标记的字段以及 SVG 图片。
   - `formatPreview(results)` 在入口处调用一次 `prepareEffectiveScrapingResults(results, results.length === 1)`，随后在 `hasValidPreview`、单链接分支与多链接分支中直接使用归一化后的 `data`，消除重复的站点匹配与 SVG 检查逻辑。

### 3. 测试更新 (`test/features/link-preview/LinkPreviewSites.test.ts`)
- 按三个阶段重组测试：
  - `SiteScraper`（`danbooruPostScraper` 匹配范围、JSON 抓取与中文标签翻译、非帖子 URL 不匹配、404 失败、429 返回 `undefined` 回退）。
  - `siteMetascraperRules`（`hackerNewsRules.test` 与 `description` 提取、`pixivRules.test` 与 `image` / `fallbackImage` 提取，补充通过 `createMetascraper(siteMetascraperRules)` 验证 `test` 门控生效的测试）。
  - `SiteDisplayRule` / `getSiteDisplayPolicy`（GitHub 单/多链接、Hacker News 去图、Danbooru 去描述）。
- 验证现有全套 `test/features/link-preview/*.test.ts`、`bun run check`、`bun run lint` 与 `bun run knip` 无回归。
