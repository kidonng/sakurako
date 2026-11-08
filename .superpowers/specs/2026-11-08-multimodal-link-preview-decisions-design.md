# 多模态链接预览决策过滤设计 (Multimodal Link Preview Decisions Design)

## 目标与背景 (Intent & Why)

### 问题现状
Sakurako 现有的链接预览语义过滤（`DecisionFilter`）通过向 OpenRouter Decisions API 发起 Noul 评估，判断链接预览相较于原消息是否具有实质性增量信息。
然而，当前的决策过程是**纯文本**的：
1. 当用户发送带有截图的消息（如“事故链接 + 事故状态截图”），OpenRouter 仅能收到包含 `[CQ:image,...]` 的纯文字字面量。
2. 模型无法感知图片中的实际内容，面对只包含简略/重复标题的网页预览时，只能在信息匮乏下“盲猜”（置信度在 50%~60% 的模糊区间徘徊）。
3. 类似地，如果用户只是发了一张无关表情包附带链接，纯文本下的长 CQ 码字符串也容易干扰模型对原消息文本密度的判断。

### 解决思路
将用户消息中的图片接入 OpenRouter 多模态 Decisions API（利用 `Perplexity Decider Flash` 或支持 Vision 的决策模型）：
- 提取用户消息中的图片，通过本地轻量下载与 `sharp` 压缩优化后转换为 Data URL；
- 以 OpenRouter 官方推荐的标准顶层 `state` 数组格式（`image_url`）传入决策模型；
- 模型同时阅读清洗后的文字上下文与附带图片，从而精准判定“预览内容是否已在图片/原消息中被完全涵盖”。

---

## 方案对比 (Approaches Considered)

### 方案 A：顶层 `state` 数组 + `sharp` 压缩预处理（已选定）
- **数据流**：
  1. 从 `IncomingMessage`（`message` 或 `raw_message`）中解析图片段并提取图片标识（`file`）。
  2. 通过 `item.context.client.downloadFileStream({ file }, { action: "download_file_image_stream" })` 从 SnowLuma 接收图片字节流，避开 QQ CDN 直链鉴权失败（-5503001）的问题。使用 `sharp` 将获取到的图片 Buffer 等比缩小至最长边 ≤ 1000px 并转为质量 80 的 JPEG，格式化为 `data:image/jpeg;base64,...`。
  3. 清洗 `user_message` 中的 CQ 码（将 `[CQ:image,...]` 替换为 `[附图]` 占位符）。
  4. 将 OpenRouter 请求 payload 中的 `state` 格式化为顶层数组：
     ```json
     "state": [
       {
         "user_message": "清洗后的文字内容",
         "previews": { "preview_0": { "url": "...", "title": "...", "description": "..." } }
       },
       {
         "type": "image_url",
         "image_url": { "url": "data:image/jpeg;base64,..." }
       }
     ]
     ```
  5. 若无图片或图片获取失败，优雅退化为纯文本对象或不带图片的数组。
- **优点**：
  - 严格遵循 OpenRouter `PerplexityDecisionsAdapter` 的多模态规范（要求图片置于顶层 `state` 数组中）；
  - `sharp` 预处理大幅缩减 payload 大小（控制在 30~80 KB）和 token 开销，消除网络延迟瓶颈；
  - 健壮的优雅降级保障：图片异常完全不阻断主链接预览逻辑。
- **缺点**：增加了一道单图下载与 `sharp` 转码步骤。

### 方案 B：OpenRouter `assets` 映射
- **数据流**：将 Base64 放入 `assets` 字典，并在文本中做引用。
- **未选择原因**：OpenRouter 文档明确指出，在非 Jev 模型（如 Perplexity Decider Flash）中，`assets` 仍会被内部展开为顶层 `image_url` 数组，且嵌套引用会触发 400 错误，增加了不必要的协议间接层。

### 方案 C：前置 Vision 模型描述转文本
- **数据流**：先调一遍通用视觉模型把图片转成文字描述，再把描述塞进 `user_message`。
- **未选择原因**：增加了一倍的 LLM 网络开销和等待延迟，且 Perplexity Decider Flash 本身就是原生的端到端多模态决策模型，无需多余转换。

---

## 详细架构与技术设计 (Architecture & Design)

### 1. 消息附图提取与下载预处理 (`LinkPreview.ts`)

在 `LinkPreview.ts` 中新增/封装用户图片提取与压缩管线：
- 从 `item.event` 中使用 `parseMessageSegments(event.message, event.raw_message)` 提取 `type === "image"` 的段落。
- 为控制网络带宽与 Token 成本，单次决策最多取首张图片（`maxUserImages = 1`），提取其 `file` 标识。
- 调用 `item.context.client.downloadFileStream({ file }, { action: "download_file_image_stream" })` 流式收集图片 `Buffer`。
- 通过 `sharp` 预处理：
  ```ts
  const processedBuffer = await sharp(buffer)
    .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${processedBuffer.toString("base64")}`;
  ```
- 任何步骤失败（连接断开、流异常、格式损坏），记录 Warning 日志并返回 `undefined`，降级为无图流程。

### 2. CQ 码清洗 (`DecisionFilter.ts` / `LinkPreview.ts`)

为了避免原消息中残留的庞大 CQ 码字符串（可能长达上百字符）干扰决策模型对文字密度的评估，在传入 `filterPreviewResults` 时对 `user_message` 进行轻量清洗：
- `[CQ:image,...]` 替换为 `[图片]`
- `[CQ:at,qq=...]` 替换为 `@用户`
- 其他无关的非文本 CQ 码直接替换为对应的简要中文标签或剥离。

### 3. Decisions 请求 Schema 升级 (`DecisionFilter.ts`)

更新 `DecisionsRequest` 接口与请求构建：
```ts
interface DecisionsImageUrlPart {
  readonly type: "image_url";
  readonly image_url: {
    readonly url: string;
  };
}

interface DecisionsStateContext {
  readonly user_message: string;
  readonly previews: Record<
    string,
    {
      readonly url: string;
      readonly title?: string;
      readonly description?: string;
      readonly standard_truncated?: string;
    }
  >;
}

type DecisionsState =
  | DecisionsStateContext
  | ReadonlyArray<DecisionsStateContext | DecisionsImageUrlPart>;
```

在 `filterPreviewResults` 中：
- 新增参数 `userImages?: ReadonlyArray<string>`（为已经转好的 `data:image/...` URL 列表）。
- 构建 `state`：
  - 若 `userImages` 存在且非空：
    ```ts
    const state: DecisionsState = [
      stateContext,
      ...userImages.map((url): DecisionsImageUrlPart => ({
        type: "image_url",
        image_url: { url },
      })),
    ];
    ```
  - 若无图片：直接使用现有的 `stateContext` 对象（完全向后兼容）。

### 4. 容错与测试策略

- **单元测试**：
  - `DecisionFilter.test.ts`：测试包含 `userImages` 时的请求序列化结构、纯文本退化分支、以及包含/不包含图片时的 Answer 响应解析。
  - `LinkPreview.test.ts`：测试包含图片 CQ 码或图片 segment 时的提取与 CQ 码清洗逻辑。
- **本地实测（Smoke Test）**：
  - 使用测试图片样本配合 OpenRouter API Key，验证包含该事故链接及事故截图时的真实 Decision 请求，观测真实模型评分（预期得分显著低于纯文本下的 0.57，形成果断过滤）。
