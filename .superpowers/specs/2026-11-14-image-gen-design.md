# `/gen` 文生图命令设计

## 背景与意图

OpenRouter 上架了限时免费的文生图模型 `recraft/recraft-v4.1-flash-v2:free`（`text->image`，有效期至 `2026-11-28`）。本改动为 Sakurako 新增 `/gen` 命令，让群聊与私聊用户可以通过自然语言提示词直接生成图片。

## 目标与非目标

- **目标**：
  - 支持 `/gen [比例] <提示词>` 文生图并直接以图片消息回复。
  - 复用现有 `OPENROUTER_API_KEY`，并要求显式配置 `OPENROUTER_IMAGE_MODEL`（无默认模型）才启用 `/gen`；同时将决策过滤调整为必须显式配置 `OPENROUTER_DECISION_MODEL`（移除默认模型）才启用。
  - 支持首词指定画幅比例（含全角冒号 `：` 归一化），空提示词时给出包含所有支持比例的用法提示。
- **非目标**：
  - 不支持图生图 / 图片编辑（`input_references` / `markup`）。
  - 不支持流式输出（`stream`）、多图并发（`n > 1`）或自定义 `provider` 路由参数。
- **反目标**：
  - 不对提示词中的非比例冒号文本（如时间 `12:30`）做误吞解析。

## 约束

- OpenRouter 图像生成端点为 `POST https://openrouter.ai/api/v1/images`，请求体包含 `model`、`prompt` 及可选 `aspect_ratio`，响应为 JSON `{ data: [{ b64_json, media_type? }] }`。
- `recraft/recraft-v4.1-flash-v2` 仅支持 `aspect_ratio`（`1:1`、`4:3`、`3:4`、`16:9`、`9:16`、`auto`）与 `n`（`1–6`），不支持流式及 `resolution`/`size`/`quality`。
- 须遵守仓库 Effect 4 规范：入口调用 `isSelfMessage` 防自回环、服务使用 `Context.Service` + `Layer.effect`、错误使用带 `brand` 的 `Schema.TaggedError`、单次处理内部兜底 `Effect.catch` 不中断主事件流。

## 实现路径对比

- **路径 A（采用）：`Context.Service`（`ImageGenClient` + `.layer`）+ 命令处理器（`handleImageGenMessage`）**
  - 沿用 `DanbooruClient` 模式：HTTP 客户端通过 `MainLive` 注入，单测可独立测试 HTTP 客户端（`makeTestHttpClient`）和命令路由（mock `ImageGenClient`），结构清晰且符合 `AGENTS.md` 服务边界规范。
- **路径 B（放弃）：无状态请求函数（类似 `SauceNao.ts`）**
  - 少一层 `Layer` 接线，但命令测试必须耦合底层 `HttpClient` 与配置细节，不利于后续扩展。

## 详细设计

1. **配置层与决策过滤对齐（`src/Config.ts`、`DecisionFilter.ts`、`LinkPreview.ts`、`.env.example`）**
   - 复用可选字段 `openrouterApiKey`（`OPENROUTER_API_KEY`），将空白字符串归一化为 `undefined`。
   - 移除 `DEFAULT_DECISION_MODEL`，将 `openrouterDecisionModel`（`OPENROUTER_DECISION_MODEL`）改为可选字段（无默认值）；仅当 `OPENROUTER_API_KEY` 与 `OPENROUTER_DECISION_MODEL` 均已配置时才启用链接预览决策过滤（未配置时跳过用户图片读取与决策请求）。
   - 新增可选字段 `openrouterImageModel`（`OPENROUTER_IMAGE_MODEL`）及 `ImageGenConfig`（无默认值）；仅当 `OPENROUTER_API_KEY` 与 `OPENROUTER_IMAGE_MODEL` 均已配置时才启用 `/gen`。
   - 启动日志 `logStartupInfo` 在 Key + 对应模型齐备时输出启用信息；若配置了模型但缺少 `OPENROUTER_API_KEY`，记录 Warning 提示。

2. **命令解析（`src/features/image-gen/ImageGenParser.ts`）**
   - 触发匹配：`parseCommand(event)` 去除前导 `@`/回复元数据后，匹配 `text === "/gen"` 或 `/^\/gen\s/.test(text)`。
   - 比例识别：提取 `/gen` 后的首个空白分隔词，将全角 `：` 替换为 `:`；仅当结果属于 `1:1`、`4:3`、`3:4`、`16:9`、`9:16` 时识别为 `aspectRatio`，否则保留为 `prompt` 的一部分（不提取 `auto`，避免误吞英文提示词）。
   - 剩余文本 trim 后为空（如 `/gen` 或 `/gen 16:9`）时判定为空提示词。

3. **OpenRouter 图像客户端（`src/features/image-gen/ImageGenClient.ts`）**
   - 定义 `ImageGenClient`（`Context.Service`）与错误类型 `ImageGenConfigError`、`ImageGenApiError`（均带 `{ readonly brand: unique symbol }`），并直接透传 `fetchJson` 的 `HttpFetchError`（含 `HttpRateLimitError`）。
   - `generateImage(prompt, aspectRatio?)` 调用 `fetchJson` 发送 `POST https://openrouter.ai/api/v1/images`（`Authorization: Bearer ...`，`timeoutDuration: "60 seconds"`），请求体省略未指定的 `aspect_ratio`。
   - 校验响应 `data[0]?.b64_json` 非空（若 `media_type` 为 `image/svg+xml` 或 `b64_json` 缺失则视为 `ImageGenApiError`），去除可能存在的 `data:...;base64,` 前缀后返回纯 base64 字符串。
   - 未配置 `OPENROUTER_API_KEY` 或 `OPENROUTER_IMAGE_MODEL` 时，`ImageGenClient` 抛出 `ImageGenConfigError`；上游 429 与超时/网络错误分别保留为 `HttpRateLimitError`、`HttpTimeoutError`/`HttpNetworkError`。

4. **命令回复与错误处理（`src/features/image-gen/ImageGen.ts`、`src/index.ts`）**
   - 入口先执行 `isSelfMessage(event)` 防自回环。
   - 功能启用检查：若 `OPENROUTER_API_KEY` 或 `OPENROUTER_IMAGE_MODEL` 未配置，回复 `[生图功能未启用]`。
   - 空提示词回复：`[请输入提示词，例如：/gen 16:9 一只橘猫（支持比例：1:1、4:3、3:4、16:9、9:16）]`。
   - 限流回复：`[生图请求过于频繁，请稍后再试]`；其他接口/超时/解码失败回复 `[生图失败]`。
   - 生成成功回复 `segments.image(\`base64://${b64}\`)`。
   - 在 `src/index.ts` 注册 `handleImageGenMessage` 与 `ImageGenClientLive`。

5. **文档与测试（留给实现阶段细化）**
   - 单元测试覆盖比例解析（半角/全角冒号、非比例时间/英文保留、空提示词）、`ImageGenClient` 请求构造与响应/错误映射、`handleImageGenMessage` 防自回环与各回复分支。
   - 更新 `docs/config.md`、`.env.example` 与新增 `docs/features/image-gen.md`。
