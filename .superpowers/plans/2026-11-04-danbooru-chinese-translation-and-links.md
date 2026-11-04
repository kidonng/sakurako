# Danbooru 结果中文化、链接附带与搜索提示优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Danbooru 检索（`/dbr`）回复附带帖子直链，将标题中的标签翻译为自然中文并处理作品名去重，优化搜索提示词比较逻辑为对比中文翻译，并在 Danbooru 链接预览中同步输出翻译后的中文标题。

**Architecture:** 
1. 在 `DanbooruTagMatcher` 中提供标签批量中文查询接口（基于本地 `assets/danbooru-tags.sqlite` 的 `cn_name`），并暴露可同步使用的轻量 SQLite 查询辅助函数；
2. 改造 `DanbooruFormatter`，支持根据标签翻译字典格式化中文标题（单作品/同系列多作品剥离角色名后缀统一在版权栏展示，跨系列多作品保留角色名后缀，连接词换为中文 `画师` 与顿号）；
3. 改造 `Danbooru.ts`，在返回文本中紧随标题附带帖子链接 `https://danbooru.donmai.us/posts/:id`，并将搜索纠错条件变更为“用户输入 != 实际搜索标签对应的中文”；
4. 改造 `LinkPreviewSites.ts` 中的 `danbooruCustomizer`，在遇到帖子链接时从 DOM 解析标签并复用中文格式化逻辑，去除 ` | Danbooru` 后缀。

**Tech Stack:** TypeScript, Bun, Effect 4, `@effect/sql-sqlite-bun`, `bun:sqlite`, `bun:test`

**Spec:** `.superpowers/specs/2026-11-04-danbooru-chinese-translation-and-links-design.md`

## Global Constraints

- Pinned Bun 1.4.4 runtime (`packages/bun.nix`, `flake.nix`).
- Effect 4 coding standards (`Effect.fn`, `Effect.fnUntraced`, `Context.Service`, branded `Schema.TaggedError`).
- Strict TypeScript rules (`verbatimModuleSyntax: true`, `.ts` extensions in relative imports).
- Zero `any` policy (`as unknown as TargetType` for mocks).
- Database missing/offline graceful degradation (fallback to English tag names without error).

## Review Focus

1. **同系列多角色去重**：如 `仓本千奈（学园偶像大师）` 和 `篠泽广（学园偶像大师）`，需剥离角色名中的作品名，作品栏统一输出 `(学园偶像大师)`。
2. **跨系列多角色保留对应关系**：如 `博丽灵梦（东方Project）` 和 `莫娜（原神）`，角色的作品后缀必须保留。
3. **数据库缺失降级运行**：`assets/danbooru-tags.sqlite` 不存在时，不抛异常崩溃，回退到英文标签原名展示。
4. **搜索提示词对比逻辑**：用户输入“白发 猫耳”匹配到“white_hair cat_ears”时因中文相同而不提示；输入英文“white_hair cat_ears”时提示 `🔍 白发 猫耳`；输入“初音”纠错为“hatsune_miku”时提示 `🔍 初音未来（VOCALOID）`。
5. **无角色或纯原创作品**：角色为空、作品为 `original` 时，正确格式化为 `原创 画师 [画师名]`；全部为空时回退为 `#[ID]`。

---

### Task 1: 标签批量翻译查询接口与辅助函数

**Files:**
- Modify: `src/features/danbooru/DanbooruTagMatcher.ts`
- Test: `test/features/danbooru/DanbooruTagMatcher.test.ts`

**Interfaces:**
- Produces:
  - `lookupDanbooruTagTranslations(tags: readonly string[], dbPath?: string): Map<string, string>`
  - `DanbooruTagMatcher.getTagTranslations: (tags: readonly string[]) => Effect.Effect<ReadonlyMap<string, string>>`

- [ ] **Step 1: 编写失败测试**

在 `test/features/danbooru/DanbooruTagMatcher.test.ts` 中新增测试用例：
```ts
it("batch translates tags to Chinese using getTagTranslations and lookupDanbooruTagTranslations", async () => {
  const matcher = await Effect.runPromise(
    DanbooruTagMatcher.pipe(Effect.provide(DanbooruTagMatcher.live())),
  );
  const translations = await Effect.runPromise(
    matcher.getTagTranslations(["white_hair", "cat_ears", "unknown_tag_xyz"]),
  );
  expect(translations.get("white_hair")).toBe("白发");
  expect(translations.get("cat_ears")).toBe("猫耳");
  expect(translations.has("unknown_tag_xyz")).toBe(false);

  const syncMap = lookupDanbooruTagTranslations(["white_hair", "cat_ears"]);
  expect(syncMap.get("white_hair")).toBe("白发");
  expect(syncMap.get("cat_ears")).toBe("猫耳");
});

it("gracefully falls back when database file does not exist", async () => {
  const syncMap = lookupDanbooruTagTranslations(
    ["white_hair"],
    "assets/non-existent.sqlite",
  );
  expect(syncMap.size).toBe(0);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/features/danbooru/DanbooruTagMatcher.test.ts`
预期：FAIL，提示 `lookupDanbooruTagTranslations` 或 `getTagTranslations` 未定义。

- [ ] **Step 3: 实现 `lookupDanbooruTagTranslations` 与 `DanbooruTagMatcher.getTagTranslations`**

在 `src/features/danbooru/DanbooruTagMatcher.ts` 中：
1. 导出纯函数 `lookupDanbooruTagTranslations(tags: readonly string[], dbPath = "assets/danbooru-tags.sqlite"): Map<string, string>`：
   - 过滤空 tags；
   - 检查文件是否存在（`fs.existsSync(dbPath)`），不存在直接返回空 `Map`；
   - 使用 `new Database(dbPath, { readonly: true })`，根据 tag 数量动态构建 `SELECT name, cn_name FROM tags WHERE name IN (...)` 查询；
   - 遍历结果存入 `Map<string, string>` 并返回。
2. 在 `DanbooruTagMatcher` service 接口中声明 `getTagTranslations: (tags: readonly string[]) => Effect.Effect<ReadonlyMap<string, string>>`；
3. 在 `DanbooruTagMatcher.layer` 和 fallback matcher 中实现 `getTagTranslations`。

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test test/features/danbooru/DanbooruTagMatcher.test.ts`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/features/danbooru/DanbooruTagMatcher.ts test/features/danbooru/DanbooruTagMatcher.test.ts
git commit -m "feat(danbooru): add tag translation lookup helper and service method"
```

---

### Task 2: 中文标题格式化逻辑 (`formatDanbooruTitle`)

**Files:**
- Modify: `src/features/danbooru/DanbooruFormatter.ts`
- Test: `test/features/danbooru/DanbooruFormatter.test.ts`

**Interfaces:**
- Consumes:
  - `translations?: ReadonlyMap<string, string>`
- Produces:
  - `formatDanbooruTitle(post: DanbooruPostTitleMeta, translations?: ReadonlyMap<string, string>): string`

- [ ] **Step 1: 编写失败测试**

在 `test/features/danbooru/DanbooruFormatter.test.ts` 中增加中文格式化与去重测试：
```ts
it("formats single character with series stripped and put into copyright", () => {
  const translations = new Map([
    ["moriya_suwako", "泄矢诹访子（东方Project）"],
    ["touhou", "东方Project"],
    ["moni_monico", "moni_monico"],
  ]);
  const title = formatDanbooruTitle(
    {
      id: 12459835,
      tag_string_character: "moriya_suwako",
      tag_string_copyright: "touhou",
      tag_string_artist: "moni_monico",
    },
    translations,
  );
  expect(title).toBe("泄矢诹访子 (东方Project) 画师 moni_monico");
});

it("formats multiple characters of the same series with series stripped", () => {
  const translations = new Map([
    ["kuramoto_china", "仓本千奈（学园偶像大师）"],
    ["shinosawa_hiro", "篠泽广（学园偶像大师）"],
    ["gakuen_idolmaster", "学园偶像大师"],
    ["idolmaster", "偶像大师"],
  ]);
  const title = formatDanbooruTitle(
    {
      id: 12509458,
      tag_string_character: "kuramoto_china shinosawa_hiro",
      tag_string_copyright: "gakuen_idolmaster idolmaster",
      tag_string_artist: "kousuke0912",
    },
    translations,
  );
  expect(title).toBe("仓本千奈、篠泽广 (学园偶像大师 等 1 部) 画师 kousuke0912");
});

it("retains character series suffix when characters belong to different series", () => {
  const translations = new Map([
    ["hakurei_reimu", "博丽灵梦（东方Project）"],
    ["mona", "莫娜（原神）"],
    ["touhou", "东方Project"],
    ["genshin_impact", "原神"],
  ]);
  const title = formatDanbooruTitle(
    {
      id: 99999,
      tag_string_character: "hakurei_reimu mona",
      tag_string_copyright: "touhou genshin_impact",
      tag_string_artist: "artist_a",
    },
    translations,
  );
  expect(title).toBe(
    "博丽灵梦（东方Project）、莫娜（原神） (东方Project 等 1 部) 画师 artist_a",
  );
});

it("formats original copyright with no character correctly", () => {
  const translations = new Map([["original", "原创"]]);
  const title = formatDanbooruTitle(
    {
      id: 88888,
      tag_string_character: "",
      tag_string_copyright: "original",
      tag_string_artist: "artist_b",
    },
    translations,
  );
  expect(title).toBe("原创 画师 artist_b");
});

it("handles more than 5 characters with '等 N 位'", () => {
  const translations = new Map([
    ["c1", "角色1（作品）"],
    ["c2", "角色2（作品）"],
    ["c3", "角色3（作品）"],
    ["c4", "角色4（作品）"],
    ["c5", "角色5（作品）"],
    ["c6", "角色6（作品）"],
    ["copy", "作品"],
  ]);
  const title = formatDanbooruTitle(
    {
      id: 77777,
      tag_string_character: "c1 c2 c3 c4 c5 c6",
      tag_string_copyright: "copy",
      tag_string_artist: "artist_c",
    },
    translations,
  );
  expect(title).toBe("角色1、角色2、角色3、角色4、角色5 等 1 位 (作品) 画师 artist_c");
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/features/danbooru/DanbooruFormatter.test.ts`
预期：FAIL，输出仍为原英文格式。

- [ ] **Step 3: 实现 `formatDanbooruTitle` 中文化逻辑**

在 `src/features/danbooru/DanbooruFormatter.ts` 中：
1. 增加辅助函数 `parseCharacterSeries(name: string): { base: string; series?: string }`：
   - 匹配末尾 `[（(]([^）)]+)[）)]$` 提取 `base` 与 `series`。
2. 改造 `formatDanbooruTitle`：
   - 支持第二个参数 `translations?: ReadonlyMap<string, string>`；
   - 角色：若 `translations` 存在，查表获取中文名（无则回退英文）；
   - 对前 5 个角色解析 `series`；若仅 1 个角色或所有角色的 `series` 均非空且完全一致，取 `base`；否则取原名；顿号 `、` 连接；若总角色数 > 5，追加 ` 等 ${charList.length - 5} 位`；
   - 作品：取第 1 个作品名翻译（若全部角色剥离了相同 `series` 且 `copyList` 为空，以 `series` 作为作品名）；若总作品数 > 1 追加 ` 等 ${copyList.length - 1} 部`；有角色时加半角括号 `(${copyStr})`；
   - 画师：多画师顿号 `、` 连接，前缀为 `画师 `；
   - 拼接并返回，无任何元数据时返回 `#[ID]`。

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test test/features/danbooru/DanbooruFormatter.test.ts`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/features/danbooru/DanbooruFormatter.ts test/features/danbooru/DanbooruFormatter.test.ts
git commit -m "feat(danbooru): format titles in Chinese with smart series deduplication"
```

---

### Task 3: `/dbr` 命令处理器升级（链接附带、搜索提示词中文比较与中文标题）

**Files:**
- Modify: `src/features/danbooru/Danbooru.ts`
- Test: `test/features/danbooru/Danbooru.test.ts`
- Test: `test/features/danbooru/DanbooruIntegration.test.ts`

**Interfaces:**
- Consumes:
  - `DanbooruTagMatcher.getTagTranslations`
  - `formatDanbooruTitle(post, translations)`
- Produces:
  - 变更后包含直链与中文提示词的 QQ 回复段落

- [ ] **Step 1: 编写失败测试**

在 `test/features/danbooru/Danbooru.test.ts` 和 `test/features/danbooru/DanbooruIntegration.test.ts` 中：
1. 断言回复的 text 包含帖子直链 `https://danbooru.donmai.us/posts/${post.id}`；
2. 当输入英文 `white_hair cat_ears` 时，断言首行提示 `🔍 白发 猫耳\n`；
3. 当输入中文 `白发 猫耳` 时，断言首行**不含** `🔍`；
4. 当输入 `初音` 时，断言首行提示 `🔍 初音未来（VOCALOID）\n`。

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/features/danbooru/Danbooru.test.ts`
预期：FAIL。

- [ ] **Step 3: 更新 `Danbooru.ts` 业务逻辑**

在 `src/features/danbooru/Danbooru.ts` 中：
1. 搜索提示词逻辑调整：
   - 查询 `searchTags` 的翻译：
     ```ts
     const searchTranslations = yield* matcher.getTagTranslations(searchTags);
     const searchTagsCn = searchTags.map(
       (t) => searchTranslations.get(t) ?? t,
     );
     const userNorm = rawQuery.trim().split(/\s+/).join(" ").toLowerCase();
     const cnNorm = searchTagsCn.join(" ").toLowerCase();
     const shouldHint = userNorm !== cnNorm;
     ```
2. 标题翻译：
   - 收集 `post` 中的所有 tag（角色、版权、画师），调用 `matcher.getTagTranslations`；
   - 传入 `formatDanbooruTitle(post, postTranslations)` 获取中文标题。
3. 消息拼接附带链接：
   ```ts
   let textContent = "";
   if (shouldHint && searchTagsCn.length > 0) {
     textContent += `🔍 ${searchTagsCn.join(" ")}\n`;
   }
   textContent += `${title}\nhttps://danbooru.donmai.us/posts/${post.id}`;
   ```

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test test/features/danbooru/Danbooru.test.ts test/features/danbooru/DanbooruIntegration.test.ts`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/features/danbooru/Danbooru.ts test/features/danbooru/Danbooru.test.ts test/features/danbooru/DanbooruIntegration.test.ts
git commit -m "feat(danbooru): add post link to reply and check search hints against Chinese tags"
```

---

### Task 4: Danbooru 链接预览标题中文化与后缀去除

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts`
- Test: `test/features/link-preview/LinkPreviewSites.test.ts`
- Test: `test/features/link-preview/LinkPreviewFormat.test.ts`

**Interfaces:**
- Consumes:
  - `lookupDanbooruTagTranslations` from `DanbooruTagMatcher.ts`
  - `formatDanbooruTitle` from `DanbooruFormatter.ts`
- Produces:
  - `danbooruCustomizer.metascraperRules.title`

- [ ] **Step 1: 编写失败测试**

在 `test/features/link-preview/LinkPreviewSites.test.ts` 中新增测试：
```ts
it("extracts tags from Danbooru post HTML DOM and formats Chinese title", () => {
  const html = `
    <html>
      <head><title>moriya suwako (touhou) drawn by moni_monico | Danbooru</title></head>
      <body>
        <ul class="character-tag-list"><li data-tag-name="moriya_suwako"></li></ul>
        <ul class="copyright-tag-list"><li data-tag-name="touhou"></li></ul>
        <ul class="artist-tag-list"><li data-tag-name="moni_monico"></li></ul>
      </body>
    </html>
  `;
  const $ = cheerio.load(html);
  const titleRule = danbooruCustomizer.metascraperRules?.title;
  expect(titleRule).toBeDefined();
  const title = titleRule!({
    htmlDom: $,
    url: "https://danbooru.donmai.us/posts/12459835",
  });
  expect(title).toBe("泄矢诹访子 (东方Project) 画师 moni_monico");
});

it("strips ' | Danbooru' suffix on non-post or fallback pages", () => {
  const html = `<html><head><title>Search: cat_ears | Danbooru</title></head></html>`;
  const $ = cheerio.load(html);
  const titleRule = danbooruCustomizer.metascraperRules?.title;
  const title = titleRule!({
    htmlDom: $,
    url: "https://danbooru.donmai.us/posts?tags=cat_ears",
  });
  expect(title).toBe("Search: cat_ears");
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`bun test test/features/link-preview/LinkPreviewSites.test.ts`
预期：FAIL，`titleRule` 未定义。

- [ ] **Step 3: 在 `danbooruCustomizer` 中实现 `metascraperRules.title`**

在 `src/features/link-preview/LinkPreviewSites.ts` 中：
1. 引入 `lookupDanbooruTagTranslations` 与 `formatDanbooruTitle`；
2. 为 `danbooruCustomizer` 添加 `metascraperRules.title`：
   - 提取 url，检测是否为 `/posts/(\d+)`：
     - 若是，从 `htmlDom` 中读取 `ul.character-tag-list li[data-tag-name]`、`ul.copyright-tag-list li[data-tag-name]`、`ul.artist-tag-list li[data-tag-name]`；
     - 若提取到了任何标签，通过 `lookupDanbooruTagTranslations` 查询对照，生成中文标题；
   - 若非 post 或无标签，从 `<title>` 或 `og:title` 提取，并去除末尾的 ` | Danbooru`。
3. 更新 `test/features/link-preview/LinkPreviewFormat.test.ts` 中 Danbooru 相关预期数据（如需更新快照或断言）。

- [ ] **Step 4: 运行测试验证通过**

运行：`bun test test/features/link-preview/LinkPreviewSites.test.ts test/features/link-preview/LinkPreviewFormat.test.ts`
预期：PASS。

- [ ] **Step 5: 提交更改**

```bash
git add src/features/link-preview/LinkPreviewSites.ts test/features/link-preview/LinkPreviewSites.test.ts test/features/link-preview/LinkPreviewFormat.test.ts
git commit -m "feat(link-preview): translate Danbooru post titles to Chinese and strip Danbooru suffix"
```

---

### Task 5: 文档更新与全量验证

**Files:**
- Modify: `docs/features/danbooru.md`

- [ ] **Step 1: 更新 `docs/features/danbooru.md`**

更新文档：
1. 回复格式小节添加直链示例：
   ```text
   🔍 [中文标签]
   [中文标题]
   https://danbooru.donmai.us/posts/12345
   [图片]
   ```
2. 详细描述搜索词提示逻辑（对比用户输入与实际检索词对应的中文标签）；
3. 说明标题标签中文化与去重规则。

- [ ] **Step 2: 运行代码检查与全量测试**

运行：
1. `bun test`
2. `bun run check`
3. `bun run lint`

预期：全部通过，无报错，无类型错误，无 linter warning。

- [ ] **Step 3: 提交更改**

```bash
git add docs/features/danbooru.md
git commit -m "docs(danbooru): document Chinese title translation, post link, and updated search hints"
```
