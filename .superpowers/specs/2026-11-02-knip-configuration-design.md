# 配置 Knip 与未引用导出全面治理设计

## 目标与背景 (Intent & Why)

### 背景与问题
Sakurako 采用 TypeScript + Bun + Effect 4 构建。当前项目未配置代码死区检测与依赖审计工具。初次通过 Knip 扫描时暴露出以下问题：
1. **未显式声明测试与脚本入口**：导致测试文件及测试单向引用的依赖/导出被误判为未引用。
2. **存在隐式跨层依赖**：测试中直接引用了 `cheerio`，但未在 `package.json` 的 `devDependencies` 中声明（借由 `metascraper` 间接安装）。
3. **TypeScript 插件依赖误报**：`tsconfig.json` 配置了 `@effect/language-service`（由 `@effect/tsgo` 内部提供），导致 Knip 报 unlisted dependency。
4. **大量内部导出未收敛**：各模块在演进过程中导出了许多未被外部跨文件引用的函数、常量、Schema 和 TaggedError 类，增加了公共接口暴露面与维护认知负担。

### 预期结果
- 建立标准的 `knip.json` 配置文件并安装 `knip`。
- 将 `cheerio` 显式补入 `devDependencies`。
- 为 `package.json` 提供 `"knip": "knip"` 校验脚本与 `"test": "bun test"` 标准脚本。
- 全面治理所有未引用的导出与类型，降为模块私有或直接清理死代码。
- 确保 `bun run knip` 零报错通过，同时现有 `bun test`、`bun run check` 与 `bun run lint` 全部通过。

---

## 目标、非目标与反目标 (Goals, Non-goals & Anti-goals)

- **目标 (Goals)**：
  1. 安装并配置 Knip，覆盖 `src/`、`scripts/` 与 `test/`。
  2. 显式补齐测试依赖 `cheerio`。
  3. 清理 23 处未使用的导出与 8 处未使用的导出类型，收敛为模块私有或安全删除（如废弃的 `runEchoBot`）。
  4. 在 `package.json` 中配置 `knip` 脚本，实现一键静态检查。
- **非目标 (Non-goals)**：
  1. 重构业务架构或改变各模块的运行逻辑。
  2. 更改测试用例的断言行为。
- **反目标 (Anti-goals)**：
  1. 滥用 Knip 的 rule ignore 机制绕过未使用的导出检查。
  2. 为规避检查而盲目删除仍然在测试中使用的导出（如 `HttpFetchError`、`BlockedHostError`、`DEFAULT_JEV_MODEL` 等）。

---

## 约束 (Constraints)

1. **环境与运行时**：Bun 1.4.4，禁止全局安装 npm 包；遵循 `verbatimModuleSyntax` 和 `@effect/tsgo` 规范。
2. **规范守则**：遵循 Linux Kernel 风格 commit message；文档与规范必须保存在 `.superpowers/`。
3. **零回归**：不破坏既有全部测试（`bun test`）。

---

## 备选方案与权衡 (Approaches)

### 方案一：源码级彻底收敛为模块私有（已选定）
- **做法**：对 Knip 报出的所有未在其他文件引用的导出，若仅在该文件内使用，移除 `export` 关键字降为私有；完全废弃的成员（如 `runEchoBot`）直接删除；并在 Knip 配置中保留完整的 exports / types 严格检查。
- **优点**：代码意图极清晰，零死导出，杜绝暴露无意义的中间层。
- **权衡**：需要对各模块逐个梳理并调整修饰符。

### 方案二：基于 Knip 规则过滤或 JSDoc 标签豁免
- **做法**：保留 Schema 与 TaggedError 类导出，在 Knip 中配置忽略规则或通过 `@public` 标签豁免。
- **缺点**：遗留大量伪公开符号，未真正治理代码死区。

---

## 详细设计 (Detailed Design)

### 1. 依赖与脚本配置 (`package.json`)
- 添加 `devDependencies`:
  - `knip`: 最新稳定版
  - `cheerio`: 匹配当前所用版本
- 添加 `scripts`:
  - `"knip": "knip"`
  - `"test": "bun test"`

### 2. Knip 配置文件 (`knip.json`)
```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    "test/**/*.test.ts"
  ],
  "project": [
    "src/**/*.ts",
    "scripts/**/*.ts",
    "test/**/*.ts"
  ],
  "ignoreDependencies": [
    "@effect/language-service"
  ]
}
```
*注：`src/index.ts` 与 `scripts/inspect-msg.ts` 会由 Knip 自动根据 `package.json` 中的 `start` 和 `inspect-msg` 脚本解析为 entry，无需在 `entry` 中冗余重复。*

### 3. 未引用导出治理清单

#### `src/features/echo/EchoBot.ts`
- `runEchoBot`: 完全废弃且未被调用，直接安全删除。

#### `src/SnowLuma.ts`
- `WebSocketConnectionError`: 仅在 `SnowLumaClient.layer` 中捕获重试时实例化，无需导出，移除 `export` 降为私有。

#### `src/features/link-preview/JevFilter.ts`
- 移除 `export` 降为私有：
  - 常量：`DEFAULT_THRESHOLD`、`DEFAULT_TIMEOUT`
  - 接口/类型：`SystemOneNoulCriteria`、`SystemOneNoulQuestion`、`SystemOneRequest`、`SystemOneAnswer`、`SystemOneResponse`
  - Schema：`SystemOneAnswerSchema`、`SystemOneResponseSchema`
  - 错误类：`JevFilterError`
- 保留导出（因在测试或 `LinkPreview.ts` 中被引用）：
  - `DEFAULT_JEV_MODEL`、`OPENROUTER_SYSTEMONE_URL`、`filterPreviewResults`

#### `src/features/link-preview/LinkPreview.ts`
- 移除 `export` 降为私有：
  - 常量：`EXPANDED_DESCRIPTION_MAX_WIDTH`
  - 插件与函数：`firstParagraphPlugin`、`isSvgUrl`、`formatErrorDetail`、`isPrivateHost`
  - 错误类：`InvalidUrlError`、`ParseMetadataError`、`SendLinkPreviewReplyError`、`FetchImageError`
  - 类型：`ScrapeMetadataError`
- 保留导出（因在测试或跨模块中被引用）：
  - `extractFirstParagraph`、`extractUrls`、`MAX_IMAGE_BYTES`、`prepareOutgoingImage`、`scrapeAll`、`scrapeMetadata`、`formatPreview`、`handleLinkPreviewMessage`、`BlockedHostError`、`HttpFetchError`、`PageMetadata`、`ScrapingResult`、`FormattedPreview`

#### `src/features/link-preview/LinkPreviewSites.ts`
- 移除 `export` 降为私有：
  - 类型：`SiteFormatOptions`
  - 常量：`siteCustomizers`
  - 函数：`createSiteMetascraperPlugin`
- 保留导出（因在测试或 `LinkPreview.ts` 中被引用）：
  - `DEFAULT_USER_AGENT`、`DANBOORU_USER_AGENT`、`DEFAULT_ACCEPT_HEADER`、`SiteCustomizer`、`MetascraperRuleContext`、`githubCustomizer`、`hackerNewsCustomizer`、`danbooruCustomizer`、`findSiteCustomizer`、`getUserAgent`、`shouldFetchImageLocally`、`siteMetascraperPlugin`

#### `src/features/sauce/SauceNao.ts`
- 移除 `export` 降为私有：
  - Schema：`SauceNaoHeaderSchema`、`SauceNaoItemHeaderSchema`、`SauceNaoItemDataSchema`、`SauceNaoItemSchema`、`SauceNaoResponseSchema`
  - 类型：`SauceNaoItemData`、`SauceNaoResponse`
- 保留导出（因在测试或 `Sauce.ts` 中被引用）：
  - `SauceNaoError`、`searchSauce`

---

## 验证与验收标准 (Verification & Acceptance)

1. `bun run knip`: 0 错误、0 警告、0 提示退出（退出码 0）。
2. `bun test`: 全部 15 个测试文件中的所有用例持续通过。
3. `bun run check`: `tsc` 类型检查通过。
4. `bun run lint`: `oxlint` 检查通过。
