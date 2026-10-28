# 链接预览缺失描述时回落正文首段设计

## 目标与背景 (Intent & Why)

在链接预览（Link Preview）功能中，部分网页未配置标准元数据（如 `og:description`、`<meta name="description">`、JSON-LD 等），导致预览结果中缺失描述行。
为了提升预览的信息完整度，在标准元数据未提供描述时，回落提取正文首个有效段落（`<p>`）作为描述文本，并同样受现有的文本宽度截断规则约束。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. 当 `metascraper-description` 及站点自定义规则未提取到描述时，自动提取正文首个有效段落作为 `description`。
  2. 采用语义过滤策略：
     - 优先在语义主体容器（`article p`、`main p`、`[role="main"] p`）内查找；未找到时回落到全局 `<p>`。
     - 排除位于噪音标签（`header`、`footer`、`nav`、`aside`、`form`、`dialog` 等）内的段落。
  3. 文本清洗：折叠连续空白与换行符为单一空格，去除首尾空白，忽略纯空白段落。
  4. 截断兼容：回落的描述文本在 `formatPreview` 中同样应用既有的 `truncate(...)` 截断逻辑（默认最大宽度 120）。
  5. 编写单元测试覆盖：正常段落回落、噪音区域过滤、语义容器优先级、多余空白清洗、全空/无段落回退等场景。

- **非目标 (Non-Goals)**：
  - 不引入庞大的文章正文提取引擎（如 Mozilla Readability）；保持轻量启发式规则。
  - 不对纯客户端渲染（SPA 无 SSR）的空白 HTML 进行无头浏览器执行。

- **反向目标 (Anti-Goals)**：
  - 避免误提取导航菜单、页脚版权、Cookie 声明或面包屑等噪音文本。
  - 避免对已由 meta 标签或自定义规则提供描述的页面造成覆盖。
  - 避免对 HTML 进行多余的二次 Cheerio DOM 解析（复用 metascraper 提供的 `htmlDom`）。

## 约束 (Constraints)

- 遵循项目既有的代码规范与 Effect 4 实践。
- 遵循 Linux Kernel 风格提交信息规范。
- 类型系统严格（`verbatimModuleSyntax: true`，禁止 `any`）。

## 方案对比与选择 (Approaches)

- **方案 1（已选）：Metascraper 规则链后置插件**
  - **实现**：在 `createMetascraper` 插件链中，将段落回落插件置于 `metascraperDescription()` 之后。
  - **权衡**：直接复用 metascraper 传入的 Cheerio 实例（`htmlDom`），零额外解析开销；且天然仅在前方所有描述规则返回空时才会触发。
- **方案 2：Effect 流程中后置解析**
  - **实现**：在 `scraper({ html, url })` 完成后，检查 `metadata.description`，若为空则在外部单独用 Cheerio 重新解析 `html`。
  - **权衡**：需要对整份 HTML 进行二次 DOM 解析，存在重复 CPU/内存开销，且描述提取逻辑碎片化。

## 决策细节 (Decisions)

1. **提取位置**：在 `src/LinkPreview.ts` 中定义 `paragraphFallbackPlugin()`（或内联至 metascraper 插件链），注入 `description` 规则。
2. **选择器与过滤算法**：
   - 候选查询顺序：
     1. `$('article p, main p, [role="main"] p')`
     2. `$('p')`
   - 对匹配的 `<p>` 元素逐个检查：
     - 使用 `$(el).closest('header, footer, nav, aside, form, dialog')` 判断是否在噪音容器中，若是则跳过。
     - 提取文本并清洗：`text.replace(/\s+/g, ' ').trim()`。
     - 若清洗后长度大于 0，即作为首段描述返回；否则继续检查下一个。
3. **截断逻辑**：直接复用 `formatPreview` 中现有的 `truncate(rawDescription)`，无需变动截断层。

## 留给构建者的细节 (Left to Builder)

- 具体的插件命名与代码组织（是否抽离纯函数 `extractFirstParagraph($)` 便于单测）。
- 测试用例的具体 HTML fixture 编写。
