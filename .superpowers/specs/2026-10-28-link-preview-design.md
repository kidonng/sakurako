# 链接预览 (Link Preview) 功能设计

## 目标与背景 (Intent & Why)

为 QQ 机器人 Sakurako 扩展第二个核心功能：链接预览（Link Preview）。
当用户在群聊或私聊中发送包含 HTTP/HTTPS 链接的消息时，机器人自动提取链接，抓取网页元数据（标题、描述、封面图），经过长度限制和格式化后，通过引用回复（Quote Reply）将结构化的网页摘要反馈给用户。
此功能可以提升聊天体验，方便群友在不打开链接前快速了解页面内容。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. 使用 `get-urls` 提取接收消息中的所有合法 URL。
  2. 使用 `metascraper` 及其插件（`metascraper-title`、`metascraper-description`、`metascraper-image`）提取网页的标题、描述和封面图。
  3. 支持 East Asian Width 字符宽度计算（CJK 字符计 2，ASCII 计 1），标题和描述截断限制为 100 宽度，超长时截断并追加省略号 `...`（截断后总宽度不超过 100）。
  4. 缺失元数据处理：
     - 缺失标题：显示 `（无标题）`；
     - 缺失描述或图片：直接省略该字段行，不留空行。
  5. 排版输出：
     - 单链接：
       ```
       [标题]
       [描述]
       [图像]
       ```
     - 多链接：
       ```
       1. [标题]
       [描述]
       2. [标题]
       [描述]
       [图像]
       ```
       （多链接排版中，仅在末尾附加首个成功获取的图像；各链接序号编号）。
  6. 错误处理与容错：
     - 单链接/多链接全部提取失败时保持静默（不发送任何回复）。
     - 部分提取失败时，对应失败项呈现为 `序号. [提取失败：原因]`。
     - 网络超时（默认 10 秒超时）及抓取异常作为可捕获错误处理。
  7. 消息回复使用 SDK 提供的引用回复 `context.quote(...)`。
  8. 保持防自回复与防循环机制：`post_type !== "message_sent" && event.user_id !== event.self_id`。
  9. 提供完善的单元测试覆盖核心逻辑（截断算法、排版格式化、错误处理）。

- **非目标 (Non-Goals)**：
  - 本期不实现需要登录态或特定 Cookie 的网页抓取（仅针对公开可访问网页）。
  - 本期不引入浏览器无头渲染（如 Puppeteer / Playwright），仅做静态 HTML 抓取。
  - 本期不对非 HTTP/HTTPS 协议（如 `ftp://`、`magnet:`）进行预览。

- **反向目标 (Anti-Goals)**：
  - 避免因单个链接抓取超时或崩溃导致整个消息事件处理流中断或卡死。
  - 避免无链接消息或全失败消息产生无意义的垃圾回复。
  - 避免将业务逻辑直接耦合在现有 `EchoBot` 中导致单文件膨胀。

## 约束 (Constraints)

- 遵循 Effect 4 开发规范（`Effect.gen`、`Effect.tryPromise`、错误通道划分与异常隔离）。
- 遵循 TypeScript 7 及项目配置规范（`verbatimModuleSyntax: true`、带 `.ts` 扩展名导入）。
- 遵循代码检查与类型检查要求（`bun run check`、`bun run lint`）。
- 外部依赖：
  - `get-urls`：URL 提取；
  - `metascraper`、`metascraper-title`、`metascraper-description`、`metascraper-image`：元数据解析。

## 技术方案对比 (Approaches)

1. **方案一：功能解耦与纯逻辑分离（选定）**
   - **设计**：
     - 拆分 `src/TextWidth.ts`：纯函数，负责字符宽度统计与截断。
     - 拆分 `src/LinkPreview.ts`：负责 URL 提取、HTML 拉取、元数据解析、排版及引用回复逻辑。
     - 消息分发：在主流程中通过并发或分发流让 `EchoBot` 与 `LinkPreview` 独立消费事件，互不干扰。
   - **权衡**：纯逻辑模块与 I/O 完全解耦，单元测试可对截断与排版做 100% 确定性单测，后续扩展新功能可无缝接入。
2. **方案二：集中式中间件链（放弃）**
   - **设计**：在 `EchoBot.ts` 内扩展为单一的集中处理链，先判断“喵喵喵”，再判断链接预览。
   - **权衡**：逻辑杂糅在同一文件，难以针对单个功能进行隔离测试与独立维护。

**选择**：方案一。

## 详细架构设计 (Detailed Design)

### 1. 文本宽度与截断 (`src/TextWidth.ts`)

- **East Asian Width 判定**：
  定义正则匹配宽字符（CJK Unified Ideographs, Fullwidth Forms, Hangul, Hiragana, Katakana 等）：
  ```ts
  const CJK_REGEX = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
  ```
  单个码点（使用 `codePointAt` 或字符遍历）：
  - 若命中 `CJK_REGEX`，宽度计为 2；
  - 否则宽度计为 1。
- **截断算法 (`truncate(text: string, maxWidth: number = 100, ellipsis: string = "..."): string`)**：
  - 计算 `text` 总宽度。若总宽度 $\le$ `maxWidth`，原样返回。
  - 计算 `ellipsisWidth`（`"..."` 宽度为 3）。目标内容宽度为 `maxWidth - ellipsisWidth`（即 97）。
  - 按字符累加宽度，一旦超过目标内容宽度立即停止，并在末尾拼接 `ellipsis`。
  - 返回总宽度不超过 `maxWidth` 的截断字符串。

### 2. 网页抓取与元数据解析 (`src/LinkPreview.ts`)

- **数据类型**：
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
  ```
- **URL 提取**：
  - 调用 `getUrls(rawMessage, { requireSchemeOrWww: true, stripWWW: false })` 获取 URL 集合并转为数组。
  - 仅保留 `http:` 和 `https:` 协议链接。
  - 去重保持原始顺序。
- **网页拉取与解析 (`scrapeUrl(url: string): Effect.Effect<PageMetadata, ScrapingError>`)**：
  - 设置统一的 `User-Agent`（模拟现代浏览器请求头，避免部分网站 403 拦截）。
  - 设置单请求超时（10 秒）。
  - 请求 HTML 字符串，随后调用 `metascraper({ html, url })` 提取 `title`, `description`, `image`。
  - 规范化标题与描述：移除首尾空白。若标题为空字符串或 undefined，则视作缺失。
  - 返回 `PageMetadata`；若 HTTP 状态码非 200 或抓取异常，捕获并返回格式化错误信息。

### 3. 消息格式化与排版 (`src/LinkPreview.ts`)

- **单链接排版 (`formatSingleResult(result: PageMetadata): { text: string; image?: string }`)**：
  - 标题：`truncate(result.title ?? "（无标题）")`
  - 描述：若存在 `result.description`，追加换行与 `truncate(result.description)`
  - 图片：若存在 `result.image`，提取出来作为附加图片
- **多链接排版 (`formatMultipleResults(results: ReadonlyArray<ScrapingResult>): { text: string; image?: string } | null`)**：
  - 若全部项皆为 `_tag: "Failure"`：返回 `null`（保持静默）。
  - 遍历每一项（从 1 开始编号）：
    - 成功项：
      ```
      ${index}. ${truncate(item.data.title ?? "（无标题）")}
      ${truncate(item.data.description)} // 若有描述
      ```
    - 失败项：
      ```
      ${index}. [提取失败：${item.reason}]
      ```
  - 图片收集：寻找首个存在有效 `item.data.image` 的成功项，作为回复唯一的附加图片。
- **回复构建与发送**：
  - 若格式化结果为 `null`，返回 `Effect.void`。
  - 构建 `OutgoingMessage`：
    - 若有图片：`[segments.text(formatted.text + (formatted.text ? "\n" : "")), segments.image(formatted.image)]`
    - 若无图片：`segments.text(formatted.text)`
  - 调用 `yield* Effect.tryPromise(() => item.context.quote(outgoingMessage))`。

### 4. 消息路由整合 (`src/EchoBot.ts` 与 `src/index.ts`)

- 在 `src/LinkPreview.ts` 中导出 `handleLinkPreviewMessage(item: IncomingMessage): Effect.Effect<void, never>`。
- 守卫条件：
  - `event.post_type !== "message_sent" && event.user_id !== event.self_id`。
  - 消息文本中含有 HTTP/HTTPS 链接。
- 在 `src/index.ts` 中整合分发：
  - 消息到达时，通过 `Effect.all([handleIncomingMessage(item), handleLinkPreviewMessage(item)], { concurrency: "unbounded" })` 并发执行两个功能插件，各自捕获异常并记录日志。

## 验证计划 (Verification Plan)

1. **单元测试 (`test/TextWidth.test.ts`)**：
   - 验证 ASCII、全角、中文字符的宽度计算。
   - 验证超长文本截断并追加 `...`，总宽度严格不超过 100。
   - 验证边界条件（空字符串、正好 100 宽度、99 宽度追加宽字符等）。
2. **单元测试 (`test/LinkPreview.test.ts`)**：
   - 验证 URL 提取与去重。
   - 验证单链接排版（全量数据、缺失标题、缺失描述、缺失图片）。
   - 验证多链接排版（全成功、部分失败、全失败静默、只取第一张图）。
   - 验证引用回复调用及防循环过滤。
3. **类型与代码规范检查**：
   - 运行 `bun run check`（`tsc` 验证 `verbatimModuleSyntax` 和类型）。
   - 运行 `bun run lint`（`oxlint` 配合 `@effect/tsgo` 规则）。
4. **真实环境联调（Smoke Test）**：
   - 启动本地机器人 `bun start`。
   - 发送单链接消息（如 GitHub、博客文章），观察引用回复排版与图片。
   - 发送多链接混合消息（含有效链接与 404/失效链接），验证编号、失败信息与首图展示。
