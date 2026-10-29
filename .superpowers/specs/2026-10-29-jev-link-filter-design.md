# 基于 Jev 决策模型的链接预览实质内容筛选设计

## 目标与背景 (Intent & Why)

当前 Sakurako 的链接预览完全基于启发式提取：从用户消息中提取所有 URL 并抓取其元数据（标题、描述、配图），然后组装成引用回复。但在实际场景中，经常出现以下两类无价值预览：
1. **正文重复**：用户发送的消息已包含完整的新闻正文或要点，链接预览提取出的标题/描述只是纯粹的文本重复，无任何实质信息增益；
2. **辅助噪音外链**：消息附带的文末群组、频道引流、投稿机器人、广告外链（如 Telegram 频道等），提取出来的预览均为通用占位语（如 "Fast. Secure. Powerful." 或频道群规）甚至携带广告配图。

为了解决该问题，引入基于 OpenRouter 托管的 TypeSafe Jev 决策模型（`~typesafe/jev-latest`），利用 `Noul`（0~1 概率的二元决策原语）在链接抓取后、发送前对各条预览进行实质信息增益评估与过滤。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. **配置支持**：在 `BotConfig` 中增加可选的 `OPENROUTER_API_KEY`（`Redacted` 类型）。
  2. **Effect 原生客户端**：基于 Effect 4 的 `HttpClient.HttpClient` 实现与 OpenRouter System One API（`https://openrouter.ai/api/v1/systemone`）的对接，零新增 npm 依赖，遵循项目的类型与错误规范。
  3. **单次批量提问**：将原始消息文本与各链接预览作为 `state`，在单次 System One 请求中为所有抓取成功的链接并发下发 Noul 评估问题，避免多次网络往返。
  4. **过滤与占位展示**：
     - **阈值判定**：Noul 概率 `>= 0.7` 判定为有效保留，`< 0.7` 判定为过滤。
     - **单链接**：若仅有 1 条链接且被过滤，整个机器人保持静默（不发引用回复）。
     - **多链接**：
       - 若全部链接均被过滤（或全失败），保持静默；
       - 若部分链接通过、部分被过滤，未通过的链接在列表中保留序号占位符：`${num}. （已过滤）`；
       - 配图仅从通过过滤的有效链接中提取（避免被过滤链接带入广告图）。
  5. **弹性降级 (Fail-open)**：
     - 若未配置 `OPENROUTER_API_KEY`，跳过过滤阶段（保持原有完整展示行为）。
     - 若 OpenRouter 请求超时、网络异常或鉴权失败，记录 warning 日志并降级为不过滤，保证基础预览不中断。
  6. **测试验证**：编写完整的单元测试覆盖单链接静默、多链接部分过滤占位、多链接全部过滤静默、未配置 Key 降级、API 异常降级等场景。

- **非目标 (Non-Goals)**：
  - 不引入官方 `@typesafe-ai/sdk`，避免第三方全局 fetch 破坏现有的 `TestHttpClient` 架构。
  - 不修改 URL 正则提取与 HTML/Metascraper 抓取的核心逻辑。
  - 不对历史会话进行上下文记忆缓存。

- **反向目标 (Anti-Goals)**：
  - 严禁在测试中 mock 全局 fetch。
  - 严禁为消息内的每个链接单独发起一次串行 HTTP 请求（必须批量提问）。
  - 避免因决策模型报错而阻断或崩溃整个 Bot 的消息流。

## 约束 (Constraints)

- 遵循项目既有的代码规范与 Effect 4 实践（`Context.Service`、`Data.TaggedError`、`HttpClient`）。
- 严格遵循 `verbatimModuleSyntax: true`，禁止 `any`。
- 遵循 Linux Kernel 风格提交信息规范。

## 方案对比与选择 (Approaches)

- **方案 1（已选）：基于 Effect `HttpClient` 原生对接 OpenRouter System One**
  - **实现**：在 `src/features/link-preview/JevFilter.ts` 中基于 `HttpClient.HttpClient` 调用 `https://openrouter.ai/api/v1/systemone`。
  - **权衡**：零外部依赖，天然融入 Effect 错误处理机制；完全复用 `test/TestHttpClient.ts` 进行无缝单测。
- **方案 2：引入官方 `@typesafe-ai/sdk`**
  - **实现**：安装 npm 包并包装进 Effect。
  - **权衡**：SDK 依赖外部环境且默认使用全局 fetch，与仓库关于 HTTP 模拟的测试要求冲突，增加封装和维护负担。

## 决策细节 (Decisions)

1. **环境配置 (`src/Config.ts`)**：
   ```ts
   openrouterApiKey: Config.option(Config.Redacted("OPENROUTER_API_KEY")).pipe(
     Config.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
   )
   ```

2. **System One 请求与 Prompt 设计**：
   - 模型：`~typesafe/jev-latest`（OpenRouter 规范别名）。
   - `state`：
     ```json
     {
       "user_message": "<raw_message>",
       "previews": {
         "link_1": { "url": "...", "title": "...", "description": "..." },
         "link_2": { "url": "...", "title": "...", "description": "..." }
       }
     }
     ```
   - `questions`：
     针对每个成功抓取的链接定义一个 Noul 问题：
     - `type`: `"noul"`
     - `instructions`: `"Does the preview for this link provide substantive, valuable, and non-redundant information beyond what is already stated in the user message?"`
     - `criteria`:
       - `true`: `"The preview provides meaningful context, new facts, or substantial details not already present in the user message, and is not promotional boilerplate, generic site greetings, or channel ads."`
       - `false`: `"The preview merely repeats information already stated in the user message, or consists of generic site slogans, channel/group promo links, submission bots, or empty boilerplate."`

3. **过滤结果类型建模 (`LinkPreview.ts`)**：
   `ScrapingResult` 增加一种状态或包装状态：
   ```ts
   export type PreviewItemResult =
     | { readonly _tag: "Success"; readonly data: PageMetadata }
     | { readonly _tag: "Filtered"; readonly url: string }
     | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError };
   ```
   - 若 `_tag === "Filtered"`，在 `formatPreview` 中多链接模式输出 `${num}. （已过滤）`。
   - `formatPreview` 判断有效性：只有包含至少一个 `_tag === "Success"` 的项，才生成最终文本；如果全是 `Filtered` 或 `Failure`，返回 `null`。
   - 配图逻辑：`firstImage` 仅从 `_tag === "Success"` 的项中提取。

4. **处理管道更新 (`handleLinkPreviewMessage`)**：
   ```
   extractUrls -> scrapeAll -> filterWithJev (若配置了 Key) -> formatPreview -> quote
   ```

## 留给构建者的细节 (Left to Builder)

- 具体的 Jev 请求超时时间（建议默认 10 秒）。
- 判定阈值常量设定（推荐 `0.7`）。
- 单元测试 fixture 的构造与各类边界情况断言。
