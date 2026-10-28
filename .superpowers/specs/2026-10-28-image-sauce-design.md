# 图片来源（SauceNao 以图搜图）与目录结构重构设计

## 目标与背景 (Intent & Why)

Sakurako 是基于 Bun 与 Effect 4 构建的 QQ 机器人，目前已有 EchoBot（回声）与 LinkPreview（链接预览）两个功能。
本次迭代旨在开发第三个核心功能：**以图搜图（图片来源查询）**。用户在群聊或私聊中引用一张图片并发送 `/sauce` 指令，机器人将调用 SauceNao API 检索该图片的出处，并以引用消息回复作品标题、作者与来源链接。

同时，随着功能的增加，当前 `src/` 根目录下平铺了所有业务与基础文件。为了保持代码库清晰度与六个月可维护性，在实现新功能前，先将 `src/` 重构为以 `src/features/` 为核心的模块化目录结构。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. **目录结构重构**：将现有业务功能收敛至 `src/features/`，包括 `src/features/echo/`、`src/features/link-preview/` 以及通用工具 `src/utils/`，更新所有相对导入并保证现有测试全部通过。
  2. **配置扩展**：在 `src/Config.ts` 中增加可选的 `SAUCENAO_API_KEY`（`Redacted` 类型），默认为空，无 key 仍可查询，配置后可使用更高限额。
  3. **SauceNao API 客户端**：在 `src/features/sauce/SauceNao.ts` 中基于 Effect `HttpClient.HttpClient` 封装 SauceNao 检索服务，支持请求参数构建、响应解析、相似度过滤（对比 `minimum_similarity`），以及从多种图站（Pixiv、推特、动画、图站等）归一化提取标题、作者与链接。
  4. **指令与消息交互**：在 `src/features/sauce/Sauce.ts` 中实现 OneBot 消息监听：
     - 严格匹配 `/sauce`（排除 `reply` 与 `at` 段后，纯文本内容严格为 `"/sauce"`）。
     - 识别消息中的 `reply` 段，调用 `SnowLumaClient.client.getMessage(messageId)` 获取被引用消息。
     - 从被引用消息中提取第一张图片 URL。
     - 异常提示：未引用消息或引用消息中无图片时回复“未在引用的消息中找到图片”；未检索到高相似度结果时回复“未找到相似度较高的图片来源”；接口出错时回复“查询失败，请稍后重试”。
     - 成功回复：使用 `context.quote` 引用用户的 `/sauce` 消息，格式为：
       ```
       [标题] by [作者]（若无作者则仅展示 [标题]）
       [链接]（若无链接则省略该行）
       ```
  5. **流水线挂载**：在 `src/index.ts` 中将 `handleSauceMessage` 与已有 EchoBot、LinkPreview 并行挂载。
  6. **单元测试与质量保证**：通过 `makeTestHttpClient` 和模拟的 `SnowLumaClient` 提供完整的正反向测试覆盖，通过 `bun test`、`bun run check`、`bun run lint`。

- **非目标 (Non-Goals)**：
  - 本期暂不支持多图同时检索（仅取引用消息中的第一张图片）。
  - 本期暂不支持图片二进制直接上传检索（QQ 消息段提供稳定的图片 URL，直接使用 `url=` 参数）。
  - 本期暂不引入除 SauceNao 之外的搜索引擎（如 ascii2d、IQDB、Google Lens）。

- **反向目标 (Anti-Goals)**：
  - 避免使用全局 `fetch` 或未经类型校验的裸请求。
  - 避免脆弱的正则字符串匹配导致 CQ 码与消息段数组格式不兼容。
  - 避免接口失败导致整个消息流崩溃或终止。

## 约束 (Constraints)

- 运行时与语言：Bun 1.4+，TypeScript 5+ / 7（`verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`）。
- 架构规范：遵循 Effect 4 实践（`Effect.gen`、`HttpClient`、`Config`、`Schema`）。
- 测试规范：使用原生 `bun:test`，HTTP 请求必须通过 `makeTestHttpClient` 注入 Mock 层，禁止 `as any`。
- 代码规范：通过 `oxlint` 及 `@effect/tsgo` 规则检查。

## 技术方案对比 (Approaches)

1. **方案 A：分层解耦与特征模块化（选定）**
   - 方式：将 SauceNao API 请求与归一化解析封装在 `src/features/sauce/SauceNao.ts`，消息与 OneBot 引用处理封装在 `src/features/sauce/Sauce.ts`。在此之前将 `src/` 重构为 `src/features/`。
   - 权衡：模块职责单一，API 归一化逻辑可通过 `makeTestHttpClient` 独立测试各类图站响应；虽然文件稍多，但结构清晰。
2. **方案 B：单文件平铺集成**
   - 方式：在 `src/Sauce.ts` 单个文件中处理 API 调用、JSON 提取与 OneBot 交互，并在 `src/` 下直接平铺。
   - 权衡：文件数少，但破坏了六个月可维护性，使 `src/` 继续恶化平铺，且多图库数据解析与 OneBot 交互杂糅，测试难以独立切分。

**选择**：方案 A。

---

## 详细设计 (Detailed Design)

### 1. 目录结构重构

重构后的目录架构如下：

```
src/
├── Config.ts
├── SnowLuma.ts
├── index.ts
├── utils/
│   └── TextWidth.ts
└── features/
    ├── echo/
    │   └── EchoBot.ts
    ├── link-preview/
    │   ├── LinkPreview.ts
    │   └── LinkPreviewSites.ts
    └── sauce/
        ├── Sauce.ts
        └── SauceNao.ts

test/
├── Config.test.ts
├── SnowLuma.test.ts
├── TestHttpClient.ts
├── utils/
│   └── TextWidth.test.ts
└── features/
    ├── echo/
    │   └── EchoBot.test.ts
    ├── link-preview/
    │   ├── LinkPreviewBot.test.ts
    │   ├── LinkPreviewEngine.test.ts
    │   ├── LinkPreviewFormat.test.ts
    │   └── LinkPreviewSites.test.ts
    └── sauce/
        ├── SauceNao.test.ts
        └── SauceBot.test.ts
```

### 2. 配置扩展 (`src/Config.ts`)

在 `BotConfig` 中新增可选字段：
```ts
export interface BotConfig {
  readonly wsUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly sauceNaoApiKey?: Redacted.Redacted<string>;
}
```
使用 `Config.option(Config.Redacted("SAUCENAO_API_KEY"))` 读取。并在 `.env.example` 中补充示例说明：
```bash
# SauceNao API Key (Optional, increases search limit)
# SAUCENAO_API_KEY=your_saucenao_api_key_here
```

### 3. SauceNao 客户端 (`src/features/sauce/SauceNao.ts`)

#### 3.1 请求构建
- API 端点：`https://saucenao.com/search.php`
- 查询参数：
  - `output_type`: `2` (JSON API)
  - `numres`: `1`（取相似度最高的第一条结果）
  - `db`: `999` (搜索全部图库)
  - `url`: 图片的公网 URL（进行 encodeURIComponent）
  - `api_key`: 若配置了 `sauceNaoApiKey`，则通过 `Redacted.value` 附加

#### 3.2 相似度校验
- SauceNao 返回头部包含 `header.minimum_similarity`（如 `60.0` 或字符串 `"60.00"`）。
- 首个结果包含 `result.header.similarity`（字符串，如 `"85.34"`）。
- 将二者转换为数值对比：若首个结果的 `similarity < minimum_similarity`，视为未匹配。

#### 3.3 标题与作者元数据归一化
SauceNao 各数据库返回字段不同，归一化规则如下：
1. **标题 (Title)**：
   - 优先读取 `data.title` (Pixiv 等)
   - 其次读取 `data.source` (动画番剧如 `source: "Fate/Zero"`，若有 `data.part` 则组合)
   - 其次读取 `data.material` / `data.jp_name`
   - 兜底为 `"未知标题"`
2. **作者 (Author)**：
   - 优先读取 `data.member_name` (Pixiv 画师名)
   - 其次读取 `data.author_name` / `data.creator`
   - 其次读取 `data.twitter_user_name` (推特作者)
   - 动画截图通常无特定画师名（作者为 undefined）
3. **外部链接 (URL)**：
   - 优先读取 `data.ext_urls[0]`
   - 若不存在，尝试从 index 特殊字段构造（如 `pixiv_id` -> `https://www.pixiv.net/artworks/${pixiv_id}`）
4. **格式化输出**：
   - 若包含有效链接：
     - 存在作者且不同于标题：`${title} by ${author}\n${url}`
     - 无作者：`${title}\n${url}`
   - 若无有效链接（部分番剧或特殊索引条目）：
     - 存在作者且不同于标题：`${title} by ${author}`
     - 无作者：`${title}`

### 4. OneBot 消息与引用处理 (`src/features/sauce/Sauce.ts`)

#### 4.1 消息触发与过滤
- 必须非机器人自身发出的消息（`post_type !== "message_sent"` 且 `user_id !== self_id`）。
- 解析消息段：
  - 支持 `event.message` 为段数组，或通过 `parseSegments(event.raw_message)` 解析 CQ 字符串。
  - 提取 `reply` 段：获取 `reply.data.id` 作为 `messageId`。
  - 提取其余内容：过滤掉 `reply` 段以及所有 `at` 段（包括 QQ 群回复时客户端自动附带的 `@原作者` 和 `@机器人`），将剩余文本段拼接并 `trim()`。
  - **严格判定**：仅当处理后文本严格全等 `"/sauce"` 时才触发后续流程。

#### 4.2 引用消息与图片提取
- 若无 `reply` 段：发送回复 `"未在引用的消息中找到图片"`。
- 若有 `reply` 段：
  - 调用 `SnowLumaClient.client.getMessage(Number(messageId))` 获取被引用的原消息对象。
  - 解析原消息中的 `message` 段（支持数组或 CQ 字符串）。
  - 查找第一个 `type === "image"` 的消息段。
  - 提取图片 URL（优先 `segment.data.url`，其次从 `segment.data.file` 判断是否为 URL）。
  - 若未找到图片消息段：发送回复 `"未在引用的消息中找到图片"`。

#### 4.3 搜索与回复响应
- 调用 SauceNao 检索：
  - 成功且高于相似度阈值：`yield* Effect.tryPromise(() => context.quote(replyText))`。
  - 无匹配或低于相似度阈值：`yield* Effect.tryPromise(() => context.quote("未找到相似度较高的图片来源"))`。
  - 检索过程发生错误（网络断开、超时、SauceNao 限额）：捕获并引用回复 `"查询失败，请稍后重试"`。

### 5. 架构与并发挂载 (`src/index.ts`)

在 `MainProgram` 中，将 `handleSauceMessage(item)` 加入并发消息处理器列表：
```ts
Stream.runForEach((item) =>
  Effect.all(
    [
      handleIncomingMessage(item),
      handleLinkPreviewMessage(item),
      handleSauceMessage(item),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid),
)
```

---

## 开发裁决说明 (Builder Calls)

1. **单结果匹配策略**：请求采用 `numres: 1` 仅评估最高相似度条目。若首条相似度不满足 `minimum_similarity` 则直接判定未找到，不进行多结果降级选择，保持逻辑简单明确。
2. **无链接结果容错**：若检索到的高相似度条目缺乏外部链接（如部分番剧截图仅包含集数信息），格式化时省略链接行，仅输出标题与作者，不输出空行或 `undefined`。
3. **At 段清洗策略**：QQ 群聊中点击回复会自动在消息开头追加对被引用者的 `@` 段，指令判定时统一剥离所有 `at` 段与 `reply` 段，确保群聊引用回复时能正常触发。

## 遗留给开发者的实现细节 (Left to Builder)

1. SauceNao 响应各字段容错（空数组、非数字相似度容错转换）。
2. 在 `SnowLumaClient` 模拟层中支持 `client.getMessage` 的 mock 返回，便于 `SauceBot.test.ts` 测试各种引用消息场景。
3. 对动画截图类型的标题格式拼接（例如若存在 `part`，可组合为 `Title EP.01`）。
