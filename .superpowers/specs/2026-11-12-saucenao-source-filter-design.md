# SauceNao 日系二次元来源过滤与多候选择优设计 (SauceNao Source Filter & Candidate Selection Design)

## 目标与背景 (Intent & Why)

### 问题现状
Sakurako 的 `/sauce` 搜图模块（`src/features/sauce/SauceNao.ts`）当前存在以下问题：
1. **全局来源噪声过大**：当前查询请求硬编码 `db: "999"`，开启了 SauceNao 的所有 40+ 个数据库。包含了大量与日系二次元无关的来源（如兽人向图库 `#29 e621`、`#40 FurAffinity`、`#42 Furry Network`，欧美商业/概念艺术站 `#34 DeviantArt`、`#39 ArtStation`，以及真人影视库 `#23 Movies`、`#24 Shows`）。在简笔、表情包压图或特征稀疏的二次元图片上极易产生哈希碰撞误报。
2. **存在大量已停更/损坏的“僵尸索引”**：SauceNao 官方状态页显示，Twitter 索引（`#41`）自 2019 年底后已停更，半次元（`#31, #32`）、Pawoo（`#35`）、MediBang（`#20`）、Sankaku（`#27`）等爬虫损坏或停服，无端增加误判概率。
3. **单结果抢占（`numres=1`）缺陷**：请求仅拉取 1 条结果。如果排在第 1 位的是一个刚好过最低相似度阈值（如 56%）的无关误报，或者是个别第三方转存，而真正的原作结果排在第 2 位，机器人只能拿到被污染的第一条。

### 核心目标
1. **限定纯正日系二次元高时效来源**：通过白名单参数限制 SauceNao 仅检索 15 个核心二次元数据库，消除无关来源与僵尸库的噪声。
2. **多结果候选拉取与择优（`numres=5`）**：将请求结果数提升至 5 条，在客户端进行二次择优。
3. **原作优先（Original Source Priority）机制**：在相似度高于阈值的前提下，当原作画师平台（如 Pixiv、Skeb、Nico Seiga、Nijie）与转存图库（如 Danbooru、Gelbooru）相似度极近时（容差范围内），优先选用原作平台结果，提供更权威的作者信息和主站链接。

---

## 方案对比 (Approaches Considered)

### 方案 A：使用 `dbs[]` 重复查询参数 + `numres=5` 客户端择优（已选定）
- **实现方式**：
  在请求 URL 中追加 `numres=5`，并通过 `searchParams.append("dbs[]", String(id))` 明确指定 15 个白名单索引 ID。
- **优点**：
  - 语义清晰，生成的请求 URL 在调试和抓包时一目了然；
  - 增删来源直观，杜绝未来 SauceNao 新增非二次元数据库时的意外污染；
  - 避免位运算在大整数（如 Index 44 Skeb 超出 JS 32 位位运算符范围）下的溢出隐患。
- **缺点**：URL query string 会包含多个 `dbs[]` 参数（共 15 个，总长增加约 100 字节，远低于 HTTP URL 长度限制）。

### 方案 B：使用 `dbmask`（Bitmask 白名单）
- **实现方式**：将 15 个库的二进制位累加得到十进制大整数（`4608805096592288`），传 `dbmask=...`。
- **未选择原因**：可读性差，日志难以肉眼判断包含哪些库，且需特殊使用 `BigInt` 防溢出。

### 方案 C：使用 `dbmaski`（黑名单屏蔽）
- **实现方式**：屏蔽 e621、DeviantArt 等少数噪声库。
- **未选择原因**：SauceNao 中损坏/过期的库过多，黑名单维护繁琐，且未来若官方加入新非二次元库仍会受影响。

---

## 详细架构与技术设计 (Architecture & Design)

### 1. 核心白名单定义 (`SauceNao.ts`)

精选 15 个日系二次元核心高时效来源：
```ts
export const TARGET_SAUCENAO_DBS = [
  5,  // pixiv (画师主站，持续更新)
  8,  // nico nico seiga (画师插画)
  9,  // danbooru (核心ACG图站，分钟级更新)
  11, // nijie (二次元/同人插画)
  12, // yande.re (高清画集壁纸，分钟级更新)
  16, // FAKKU (商业单行本/漫画)
  18, // H-Misc nhentai (同人志)
  21, // Anime (动画截图与新番)
  22, // H-Anime (动画)
  25, // Gelbooru (ACG图站，分钟级更新)
  26, // Konachan (壁纸插画，分钟级更新)
  28, // Anime-Pictures (高质量ACG图站，分钟级更新)
  37, // MangaDex (连载漫画，分钟级更新)
  38, // H-Misc ehentai (同人志)
  44, // Skeb (画师约稿平台)
] as const;
```

### 2. URL 参数构造

使用标准 Web `URL` 与 `searchParams` 构造请求：
```ts
const url = new URL(SAUCENAO_API_URL);
url.searchParams.set("output_type", "2");
url.searchParams.set("numres", "5");
url.searchParams.set("url", imageUrl);
for (const db of TARGET_SAUCENAO_DBS) {
  url.searchParams.append("dbs[]", String(db));
}
if (apiKey) {
  url.searchParams.set("api_key", Redacted.value(apiKey));
}
```

### 3. 结果候选择优逻辑 (`selectBestSauceResult`)

定义画师原作直属平台集合：
```ts
const PRIMARY_ORIGIN_DBS = new Set([
  5,  // Pixiv
  8,  // Nico Nico Seiga
  11, // Nijie
  44, // Skeb
]);
```

择优策略：
1. **阈值过滤**：从 `results` 列表中过滤出所有 `similarity >= minSimilarity` 的有效候选。若无候选满足条件，返回 `null`。
2. **最高相似度基准**：取得分最高的候选 `highestMatch` 及其相似度 `maxSimilarity`。
3. **原作优先（近相似度容差）**：
   - 容差窗口设为 `SIMILARITY_ORIGIN_TOLERANCE = 2.0`（百分比）；
   - 在所有满足 `similarity >= maxSimilarity - 2.0` 的高分候选中，如果存在来自 `PRIMARY_ORIGIN_DBS` 的结果，优先选择其中相似度最高的原作平台项；
   - 否则直接采纳 `highestMatch`。
4. **格式化输出**：提取选定项的 `title`、`author`、`url` 并拼装 `formattedText`。

---

## 边界与兼容性考量 (Edge Cases & Invariants)

1. **接口兼容性不变**：`searchSauce` 的入参（`imageUrl`, `apiKey`）和返回值（`SauceResult | null`）保持 100% 稳定，不破坏现有上层调用。
2. **网络异常与空结果兼容**：若所有 5 个结果均低于最低相似度阈值或结果为空，依然安全返回 `null`。
3. **缺失 `index_id` 的兼容**：若 SauceNao 返回的某条 result header 缺失 `index_id`，降级为常规按相似度排序，不影响解析。
4. **Danbooru 引用优先权**：若某张图只有 Danbooru 命中（例如 Pixiv 被画师删除或来自 Twitter），Danbooru 作为最高分候选依然能正常返回。

---

## 验证计划 (Verification Plan)

### 自动化单元测试 (`test/features/sauce/SauceNao.test.ts`)
1. **请求 URL 验证**：断言发送给 HttpClient 的请求 URL 包含 `numres=5` 以及全部 15 个 `dbs[]` 参数，且不再包含 `db=999`。
2. **多候选择优逻辑**：
   - 测试场景 A（最高分胜出）：Danbooru 95% vs 无关项 60%，返回 Danbooru；
   - 测试场景 B（原作优先）：Danbooru 91.5% vs Pixiv 90.5%（差距在 2% 以内），优先返回 Pixiv；
   - 测试场景 C（差距过大不选劣质原作）：Danbooru 95% vs Pixiv 70%，返回 Danbooru；
   - 测试场景 D（全低于阈值）：所有结果低于 `minimum_similarity`，返回 `null`。
3. **现有测试回归**：运行 `bun test test/features/sauce/`，确保原有全部测试用例保持通过。
