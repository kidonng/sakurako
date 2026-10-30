# 基于 Jev 双重 Noul 门控的动态截断机制设计

## 目标与背景 (Intent & Why)

### 问题现状
Sakurako 接入 Jev 决策过滤后，发现部分链接预览未被预期过滤：
- 当用户发出的消息已经引用了新闻的前文时，HTML `<meta name="description">` 后半段往往包含未被用户提及的新事实。
- Jev 看到的是完整的 120+ 字 description，判定整体有增量信息（`noul = 0.90`）并放行。
- 但随后的 `formatPreview` 使用硬编码的 `truncate(rawDescription, 100)` 截断文本，直接丢弃了后半段的新事实，导致最终发送到 QQ 群的引用文本仅剩下前半段完全冗余的内容。

### 解决思路
针对截断丢弃有效事实的问题，若直接切分抽取孤立句子展示，容易因脱离上下文破坏主谓语和指代关系（例如“他表示……”、“该公司……”缺少主语）。因此：
- 保留从文本起始处连续阅读的自然上下文；
- 引入 **方案 B：双重 Noul 门控与动态截断**：
  1. `preview_${i}_has_substantive_info`（决定“发不发”）：整体网页元数据是否包含实质增量信息。若未通过，直接静默过滤。
  2. `preview_${i}_standard_is_sufficient`（决定“长不长”）：标准截断（前 100 宽度）是否已足以表达增量信息。若整体通过但标准截断不足以表达（增量信息被截断丢弃），则动态放宽截断限制（扩展至 280 宽度），将后半段的新事实完整呈现给群友。

---

## 架构与技术设计 (Architecture & Design)

### 1. 数据结构扩展

在 `ScrapingResult` 的 `Success` 状态中增加可选标记 `expanded?: boolean`：

```ts
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

### 2. JevFilter 双重 Noul 评估

在 `filterPreviewResults` 中：
- 对于每个成功的预览条目 `entry`：
  - 计算其标准截断文本 `standard_truncated = truncate(description, 100)`。
  - 构建状态 `previews[key]`:
    ```json
    {
      "url": "...",
      "title": "...",
      "description": "...",
      "standard_truncated": "..."
    }
    ```
  - 发送两道 Noul 问题：
    1. `${key}_has_substantive_info`:
       - `instructions`: "Does the preview for this link provide substantive, valuable, and non-redundant information beyond what is already conveyed in the user message?"
       - `criteria`: 现有的 `NOUL_CRITERIA`。
    2. `${key}_standard_is_sufficient`:
       - `instructions`: "Does `previews.${key}.standard_truncated` convey the substantive new facts not in `user_message`?"
       - `criteria`:
         - `true`: "The standard truncated excerpt already conveys meaningful new facts not present in user_message."
         - `false`: "The standard truncated excerpt merely repeats what was in user_message, while any new facts only exist further down in description or are absent entirely."
       - *优化*：若 `stringWidth(description) <= 100`，标准截断未截掉任何字符，则无需提问问题 2，直接默认充分。

### 3. 决策判决逻辑

- 若 `has_substantive_info < threshold`：标记为 `{ _tag: "Filtered", url }`。
- 若 `has_substantive_info >= threshold`：
  - 若提问了问题 2 且 `standard_is_sufficient < threshold`：说明增量信息在尾部，标记为 `{ _tag: "Success", data, expanded: true }`。
  - 否则：标记为 `{ _tag: "Success", data, expanded: false }`。

### 4. 渲染输出

在 `LinkPreview.ts` 的 `formatPreview` 中：
- 标准宽度常量：`DEFAULT_DESCRIPTION_MAX_WIDTH = 100`
- 扩展宽度常量：`EXPANDED_DESCRIPTION_MAX_WIDTH = 280`
- 当 `item.expanded === true` 时，使用 `truncate(rawDescription, EXPANDED_DESCRIPTION_MAX_WIDTH)`；否则使用 `DEFAULT_DESCRIPTION_MAX_WIDTH`。
