# Danbooru 图片检索与标签智能匹配设计

## 目标与背景 (Intent & Why)

Sakurako 目前已具备 EchoBot（回声）、LinkPreview（链接预览）、Sauce（以图搜图）以及 Stats（消息统计）等核心功能。
本次迭代旨在引入 **Danbooru 随机图片检索功能 (`/dbr`)**：
1. 允许群聊用户通过 `/dbr [可选搜索词]` 获取 Danbooru 上的精选高质量 SFW 插画；
2. 解决 Danbooru 纯英文标签门槛高、用户容易拼错且不支持中文检索的问题，通过本地离线标签对照库（33 万条中英映射及热度）进行智能转换与容错选优；
3. 严格遵循 Danbooru 搜索规范与安全约束（强制 `is:sfw is:active`，限制最多 2 个普通 tag）；
4. 以 Danbooru 官方页面标题规范（`角色 (作品) drawn by 画师`）配图发送，并在输入词发生转换/纠错时友好回显实际搜索词。

---

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

### 目标 (Goals)
1. **对照数据库管理**：
   - 提供 `scripts/download-danbooru-tags.ts` 脚本和 `package.json` 中的 `bun run download-tags` 指令，从 `ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table` 下载最新的 `tag.sqlite` 至 `assets/danbooru-tags.sqlite`。
   - 在 `.gitignore` 中增加 `assets/*.sqlite` 忽略对照数据库。
   - 自动检测并为 `name` 与 `cn_name` 补充必要索引（若尚未建立），确保查询为 $O(1)$ 或轻量范围扫描。
2. **标签智能匹配与转换 (`DanbooruTagMatcher`)**：
   - 基于 `effect/sql`（`@effect/sql-sqlite-bun` 的 `SqliteClient` 提供只读 `SqlClient.SqlClient`）进行数据库操作；
   - 支持空搜索词：无输入时直接返回随机 SFW 活跃图片；
   - 支持中文转英文 Tag：通过 `cn_name` 映射为 Danbooru 标准 `name`（如 `白发` -> `white_hair`）；
   - 支持英文拼写容错：对用户输入的英文单词，在完全匹配失败时，通过前缀检索或轻量编辑距离（Levenshtein）匹配候选，结合 `post_count` 热度排序，选取最可能的 Danbooru Tag；
   - 多词组合：以空格分隔输入词，逐词解析；
   - 标签数量限制：如果解析得到的普通 Tag 数量 $> 2$（Danbooru 未登录接口上限），直接回复提示 `[标签数量超出限制，最多支持 2 个]`；
   - 无效标签反馈：如果用户输入了搜索词，但所有词条均无法匹配到有效 Tag，回复 `[未找到匹配的标签]`。
3. **Danbooru API 客户端 (`DanbooruClient`)**：
   - 基于项目现有的 `src/utils/HttpClient.ts`（`executeWithResponse`）访问 Danbooru API：`https://danbooru.donmai.us/posts/random.json?tags=is:sfw+is:active+...`；
   - 请求头注入标准 `User-Agent: SakurakoBot/1.0 (https://github.com/kidonng/sakurako)`；
   - 处理各类响应状态：
     - HTTP 200：解析 `DanbooruPostSchema` 返回 Post 实体；
     - HTTP 204 / 404 / 空响应：标记为无结果，回复 `[未找到符合条件的图片]`；
     - HTTP 429：回复 `[Danbooru 请求过于频繁，请稍后再试]`；
     - HTTP 5xx / 网络超时 / `HttpFetchError`：回复 `[Danbooru 接口请求失败]`。
4. **标题格式化与消息呈现 (`DanbooruFormatter` & `Danbooru.ts`)**：
   - 复刻 Danbooru 官方 `humanized_essential_tag_string` 算法：
     - **角色 (Characters)**：从 `tag_string_character` 提取，最多展示前 5 个，超过 5 个追加 `X more`，组合为标准英文句子列表；
     - **作品 (Copyrights)**：从 `tag_string_copyright` 提取，最多展示前 1 个，超过 1 个追加 `X more`；若同时有角色，用括号包裹 `(copyright)`；
     - **画师 (Artists)**：从 `tag_string_artist` 提取，格式化为 `drawn by artist1, artist2`；
     - **兜底**：若上述标签均为空，使用 `#ID`。
   - 消息回复格式：
     - 若实际搜索词与用户输入的内容不一致（如经过中文翻译、下划线转换或拼写纠错），首行增加 `🔍 [实际搜索词]`（例如 `🔍 white_hair cat_ears`）；
     - 接着换行展示格式化标题；
     - 附带图片发送（优先使用 `post.large_file_url`，回退到 `post.file_url`）。
5. **集成与测试覆盖**：
   - 在 `src/index.ts` 消息处理流水线中挂载 `handleDanbooruMessage`；
   - 提供单元测试覆盖标签匹配逻辑、标题格式化、API Client 模拟（`makeTestHttpClient`）以及指令路由全部分支。

### 非目标 (Non-Goals)
- 本期不支持 NSFW / R18 图片检索（强制注入 `is:sfw is:active`）。
- 不支持复杂的布尔搜索语法（如 `~tag` OR 运算或 `-tag` 排除运算），用户输入的多词按默认空格 AND 处理。
- 不支持群内发送指令触发对照库的在线更新（通过服务端 CLI 脚本维护）。

### 反向目标 (Anti-Goals)
- 避免全量加载 33 万词条到 Node/Bun 内存（避免常驻内存膨胀）。
- 避免引入外部需要编译的 C/C++ SQLite 分词扩展（如 FTS5 jieba/simple），保持跨平台与依赖纯净。
- 避免接口异常未捕获导致主消息流中断。

---

## 约束 (Constraints)

- **语言与运行时**：Bun 1.4+，TypeScript 5+（`verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`）。
- **架构范式**：遵循 Effect 4 标准（`Effect.gen`, `Context.Service`, `HttpClient.HttpClient`, `Schema`）。
- **测试规范**：原生 `bun:test`，HTTP 请求使用 `makeTestHttpClient` 模拟，禁止 `any` 与全局 fetch mock。
- **质量检查**：必须通过 `bun test`、`bun run check`（tsc）、`bun run lint`（oxlint + @effect/tsgo）。

---

## 技术方案对比 (Approaches)

### 方案 1：SQLite 索引直查 + 分级匹配（选定）
- **机制**：
  使用 `effect/sql`（`@effect/sql-sqlite-bun` 的 `SqliteClient.layer` 提供只读 `SqlClient.SqlClient`），连接 `assets/danbooru-tags.sqlite`。建立 `idx_danbooru_tags_name` 和 `idx_danbooru_tags_cn_name` 索引。匹配分三级：
  1. **精确命中**：`sql` 模板标签查询 `WHERE name = ${word} COLLATE NOCASE OR cn_name = ${word}`（耗时 $< 0.2\text{ms}$）；
  2. **前缀匹配**：`sql` 查询 `WHERE (name LIKE ${word + "%"} OR cn_name LIKE ${word + "%"}) ORDER BY post_count DESC LIMIT 20`（耗时 $< 1\text{ms}$）；
  3. **容错纠错**：若前缀无果，基于全表包含与 Levenshtein 编辑距离进行候选筛选，结合 `post_count` 加权选优（全表扫描耗时约 $30\sim 40\text{ms}$，在聊天消息场景中完全流畅）。
- **权衡**：
  无需二次加工或重构表结构；零额外内存占用；使用 `effect/sql` 统一 SQL 访问范式；对中文 1~4 字完全友好，规避了分词器限制。

### 方案 2：SQLite FTS5 全文索引
- **机制**：
  将对照库导入 FTS5 虚拟表并使用内置分词器检索。
- **权衡**：
  虽然单次查询召回范围广，但默认 `unicode61` 分词器无法切分 CJK；而内置的 `trigram` 强制词长 $\ge 3$ 个字符，导致“白发”、“猫耳”、“女仆”等最主流的 2 字中文 Tag 无法检索；引入第三方 C 编译分词插件又严重破坏部署便利性。故不采纳。

### 方案 3：全内存 Trie / Map 检索
- **机制**：
  启动时将 33 万词条全部加载到 JS 堆内存中。
- **权衡**：
  堆内存暴增 100MB+，启动延迟增加 2~3 秒，违背 Sakurako 轻量常驻设计。故不采纳。

**结论**：选定方案 1。

---

## 详细设计 (Detailed Design)

### 1. 模块组织

```
src/features/danbooru/
├── Danbooru.ts             # 消息监听器与交互路由 (handleDanbooruMessage)
├── DanbooruClient.ts       # Danbooru API 客户端 (Context.Service & Layer)
├── DanbooruFormatter.ts    # 官方标题算法与消息排版
└── DanbooruTagMatcher.ts   # 标签数据库连接、索引管理与多级模糊匹配 (使用 effect/sql)

scripts/
└── download-danbooru-tags.ts # 对照库下载与索引确保脚本 (保存至 assets/)

test/features/danbooru/
├── DanbooruTagMatcher.test.ts
├── DanbooruFormatter.test.ts
├── DanbooruClient.test.ts
└── Danbooru.test.ts
```

### 2. 对照数据库与下载脚本 (`download-danbooru-tags.ts`)

- 目标路径：`assets/danbooru-tags.sqlite`；
- 下载源：`https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite`（约 24MB）；
- 索引初始化：下载完成后，执行：
  ```sql
  CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_tags_cn_name ON tags(cn_name);
  CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);
  ```
- 在 `package.json` 的 `scripts` 中添加 `"download-tags": "bun scripts/download-danbooru-tags.ts"`；
- 在 `.gitignore` 中增加 `assets/*.sqlite` 忽略对照数据库。

### 3. 标签匹配器 (`DanbooruTagMatcher.ts`)

```ts
export class DanbooruTagMatcher extends Context.Service<DanbooruTagMatcher, {
  readonly matchTag: (word: string) => Effect.Effect<string | undefined>;
  readonly matchQuery: (rawQuery: string) => Effect.Effect<{
    readonly tags: readonly string[];
    readonly isModified: boolean;
  }>;
}>()("sakurako/danbooru/DanbooruTagMatcher") {
  static readonly layer: Layer.Layer<
    DanbooruTagMatcher,
    never,
    SqlClient.SqlClient | FileSystem.FileSystem
  >;
}
```

匹配逻辑（`matchTag`）：
1. 规范化输入（去除首尾空白字符，转小写）；
2. 第一级：完全匹配 `sql` 查询 `WHERE name = ${word} COLLATE NOCASE OR cn_name = ${word} LIMIT 1`；
3. 第二级：前缀匹配 `sql` 查询 `WHERE (name LIKE ${word + "%"} OR cn_name LIKE ${word + "%"}) ORDER BY post_count DESC LIMIT 20`，如果命中返回 `post_count` 最高者；
4. 第三级：英文模糊纠错（当且仅当输入仅包含英文字母/数字/下划线时），执行包含匹配 `sql` 查询 `WHERE name LIKE ${"%" + word + "%"} ORDER BY post_count DESC LIMIT 50` 并结合 Levenshtein 距离相似度过滤；若无命中且原词符合 Danbooru 英文 tag 规范，可直接将原词作为候选；
5. 若输入为纯中文但无法匹配到任何 tag，返回 `undefined`。

多词匹配逻辑（`matchQuery`）：
- 用连续空格分词：`rawQuery.trim().split(/\s+/)`；
- 对每个 token 调用 `matchTag`；
- 若解析出的有效 tag 列表去重后非空：
  - 对比解析得到的 tags 串（空格拼接）与用户原始输入（小写去空格拼接）；若存在差异，`isModified` 为 `true`；
  - 返回 `{ tags, isModified }`。

数据库层依赖隔离：
在 `DanbooruTagMatcher.layer` 中，通过独立为该模块注入 `SqliteClient.layer({ filename: "assets/danbooru-tags.sqlite", readonly: true })`，避免与 `StatsRepository` 的 `SqlClient.SqlClient` 冲突。
若 `assets/danbooru-tags.sqlite` 尚不存在，匹配器优雅降级为原词返回并打印 Warning，不阻断系统启动。

### 4. Danbooru API 客户端 (`DanbooruClient.ts`)

- API Endpoint：`https://danbooru.donmai.us/posts/random.json`
- 查询参数：`tags=is:sfw is:active ${tagString}`
- 请求实现：复用 `src/utils/HttpClient.ts` 中的 `executeWithResponse`：
  - 注入 `User-Agent: SakurakoBot/1.0 (https://github.com/kidonng/sakurako)`；
  - HTTP 204 处理为 `DanbooruNotFoundError`；
  - HTTP 200 解析为 `DanbooruPostSchema`；
  - 捕获 `HttpFetchError`：状态 404 转为 `DanbooruNotFoundError`，状态 429 转为 `DanbooruRateLimitError`，其他转为 `DanbooruApiError`。

```ts
export const DanbooruPostSchema = Schema.Struct({
  id: Schema.Finite,
  file_url: Schema.optional(Schema.String),
  large_file_url: Schema.optional(Schema.String),
  preview_file_url: Schema.optional(Schema.String),
  tag_string_character: Schema.String,
  tag_string_copyright: Schema.String,
  tag_string_artist: Schema.String,
  tag_string_general: Schema.String,
});
export type DanbooruPost = typeof DanbooruPostSchema.Type;

export class DanbooruNotFoundError extends Schema.TaggedError<
  DanbooruNotFoundError,
  { readonly brand: unique symbol }
>()("DanbooruNotFoundError", { queryTags: Schema.String }) {}

export class DanbooruRateLimitError extends Schema.TaggedError<
  DanbooruRateLimitError,
  { readonly brand: unique symbol }
>()("DanbooruRateLimitError", {}) {}

export class DanbooruApiError extends Schema.TaggedError<
  DanbooruApiError,
  { readonly brand: unique symbol }
>()("DanbooruApiError", {
  status: Schema.Finite,
  message: Schema.String,
}) {}

export class DanbooruClient extends Context.Service<DanbooruClient, {
  readonly getRandomPost: (
    tags?: readonly string[],
  ) => Effect.Effect<
    DanbooruPost,
    DanbooruNotFoundError | DanbooruRateLimitError | DanbooruApiError
  >;
}>()("sakurako/danbooru/DanbooruClient") {
  static readonly layer: Layer.Layer<DanbooruClient, never, HttpClient.HttpClient>;
}
```

### 5. 标题生成与排版 (`DanbooruFormatter.ts`)

函数：`formatDanbooruTitle(post: DanbooruPost): string`
- 算法严格对标 Danbooru 官方呈现规则：
  ```ts
  // 1. 角色
  const charList = splitTags(post.tag_string_character);
  const chars = charList.slice(0, 5);
  if (charList.length > 5) chars.push(`${charList.length - 5} more`);
  const charStr = toSentence(chars);

  // 2. 作品版权
  const copyList = splitTags(post.tag_string_copyright);
  const copies = copyList.slice(0, 1);
  if (copyList.length > 1) copies.push(`${copyList.length - 1} more`);
  let copyStr = toSentence(copies);
  if (charStr && copyStr) copyStr = `(${copyStr})`;

  // 3. 画师
  const artistList = splitTags(post.tag_string_artist);
  let artistStr = toSentence(artistList);
  if (artistStr) artistStr = `drawn by ${artistStr}`;

  // 4. 组合或降级
  const combined = [charStr, copyStr, artistStr].filter(Boolean).join(" ").trim();
  return combined || `#${post.id}`;
  ```
- `toSentence` 工具函数：按照英文习惯连接数组（`"a"`, `"a and b"`, `"a, b, and c"`）。

### 6. 交互处理流水线 (`Danbooru.ts`)

1. **防环防自身**：`if (isSelfMessage(event)) return;`
2. **命令匹配**：
   - 提取纯文本命令。若以 `/dbr` 开头（支持 `/dbr` 后面紧跟空格或直接结束）：
   - 若不匹配 `/dbr`，立即返回。
3. **参数解析与校验**：
   - 获取 `/dbr` 后的参数字符串；
   - 若参数为空：直接查询，无附加 tag；
   - 若参数不为空：
     - 调用 `DanbooruTagMatcher.matchQuery(param)`；
     - 若解析后的 tags 数量 $> 2$：
       调用 `item.context.reply("[标签数量超出限制，最多支持 2 个]")`，结束；
     - 若所有词条均未匹配到有效 tag（返回 tags 为空）：
       调用 `item.context.reply("[未找到匹配的标签]")`，结束。
4. **获取图片**：
   - 调用 `DanbooruClient.getRandomPost(tags)`；
   - 捕获错误：
     - `DanbooruNotFoundError` -> `item.context.reply("[未找到符合条件的图片]")`；
     - `DanbooruRateLimitError` -> `item.context.reply("[Danbooru 请求过于频繁，请稍后再试]")`；
     - 其他错误 -> `item.context.reply("[Danbooru 接口请求失败]")`。
5. **组装与发送回复**：
   - 提取图片 URL（优先 `large_file_url`，其次 `file_url`）；若均无有效 URL，回复 `[未获取到有效图片链接]`；
   - 构建消息体：
     - 如果 `isModified` 为 true，首行为 `🔍 ${tags.join(" ")}\n`；
     - 标题行：`${formatDanbooruTitle(post)}\n`；
     - 图片段：`segments.image(imageUrl)`。
   - 调用 `item.context.reply(...)` 发送消息。

---

## 留给开发者的实现细节 (Left to the Builder)

1. Levenshtein 算法实现：可使用紧凑高效的动态规划纯函数，无需引入额外 npm 包；
2. 数据库缺失处理：若本地尚未运行 `bun run download-tags` 导致 `assets/danbooru-tags.sqlite` 文件不存在，匹配器应记录 Warning 并优雅降级为将用户的英文输入原样透传，而不应导致服务启动崩溃；
3. 日志规范：遵循已有的 `formatLogMessagePrefix(event)` 统一前缀输出。
