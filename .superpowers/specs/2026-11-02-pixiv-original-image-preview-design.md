# Pixiv 链接预览原图化设计方案

## 1. 背景与意图 (Intent & Why)

Pixiv 页面默认提供的 Open Graph / Twitter 预览图片是由 `embed.pixiv.net/decorate.php` 动态生成的装饰卡片，原图会被裁剪为固定比例并附加边框或水印。在聊天窗口进行链接预览时，用户希望能够直接查看完整的插画原图。

由于 Pixiv 官方图片服务器 `i.pximg.net` 存在防盗链（需 Referer），本功能利用社区成熟的反向代理服务 `https://pixiv.cat/` 为插画提供原图链接；同时在 pixiv.cat 无法正常响应（如作品受限、删除、多图异常或超时）时，无缝回退到页面原有的 `og:image` 裁剪图。

---

## 2. 目标、非目标与反目标 (Goals, Non-goals, Anti-goals)

### 目标 (Goals)
1. **插画原图解析**：当提取到的链接属于 Pixiv 作品链接（如 `/artworks/:id`、`/:lang/artworks/:id` 或 `/member_illust.php?...illust_id=:id`）时，链接预览图片优先使用 `https://pixiv.cat/${illustId}.jpg`。
2. **多图作品兼容**：利用 pixiv.cat 对单作品 ID 的 301 重定向特性，自动兼容多图作品（重定向至第一张原图）。
3. **优雅降级 (Fallback)**：若 pixiv.cat 原图获取失败（4xx/5xx、超大文件、非合法图片或超时），自动降级尝试抓取该页面原本的 `og:image` 裁剪图。
4. **非插画链接穿透**：对于画师个人主页（`/users/:id`）、排行榜（`/ranking.php`）等非插画链接，保持原有通用的 Open Graph 预览机制。

### 非目标 (Non-goals)
- 不支持在单条链接预览中分页提取多图作品的所有后续图片（链接预览规范每条最多展示一张代表图）。
- 不自建 pximg 代理，直接使用 `pixiv.cat`。

### 反目标 (Anti-goals)
- 严禁因为 pixiv.cat 服务偶发不稳定或 404 导致整条链接预览失败或静默；必须确保有 `og:image` 兜底。
- 不在元数据解析阶段发起冗余探测请求，避免翻倍网络开销。

---

## 3. 技术约束与规范 (Constraints)

- **Effect 4 与 TypeScript 7**：保持既有的 Effect 规范与错误处理范式。
- **本地 Base64 下载**：Sakurako 统一由本地拉取图片并转为 Base64 发送给 SnowLuma，复用既有 10 MB 体积限制、Content-Type 校验及超时保护。
- **单测覆盖与零冗余**：遵循项目规范，对 URL 匹配与 ID 提取、降级逻辑进行行为测试，不编写常数或重言式测试。

---

## 4. 技术方案对比 (Approaches)

### 方案一：多候选图片地址顺序回退（已选定）
- **实现**：
  1. 在 `LinkPreviewSites.ts` 中新增 `pixivCustomizer`，在 `metascraperRules` 中为插画提取 `image`（`https://pixiv.cat/${id}.jpg`）与 `fallbackImage`（提取 HTML 中的 `og:image`）。
  2. 扩展 `PageMetadata` 与 `FormattedPreview`，支持传递 `fallbackImage`。
  3. 在 `prepareOutgoingImage` 中支持候选回退：优先下载并校验主图；若下载失败且存在 `fallbackImageUrl`，自动降级尝试拉取备选图。
- **权衡**：
  - 优点：职责单一，下载与校验完全内聚在 `prepareOutgoingImage`，无额外探测开销；容错与降级行为高度可靠。
  - 代价：微调元数据结构与图片拉取函数参数。

### 方案二：元数据提取阶段预检探测
- **实现**：在 `scrapeMetadata` 解析后，向 `pixiv.cat` 发送 HEAD 请求探测可用性，若可用则直接写入 `image`，不可用则保留 `og:image`。
- **权衡**：
  - 优点：下游无需感知 fallback。
  - 缺点：增加元数据抓取阶段网络往返，成功时产生二次请求，增加端到端延迟。

**选择原因**：用户选定方案一。

---

## 5. 详细实现设计 (Detailed Design)

### 5.1 Pixiv 作品 URL 匹配与 ID 提取
在 `LinkPreviewSites.ts` 中：
- `match`: 域名严格匹配 `pixiv.net` 或 `*.pixiv.net`（如 `www.pixiv.net`）。
- `extractPixivArtworkId(url: URL): string | undefined`:
  - 路径匹配：`pathname` 匹配 `^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)`（支持 `/artworks/123` 及 `/en/artworks/123`）。
  - 查询参数匹配：路径为 `/member_illust.php` 且查询参数包含 `illust_id`（纯数字）。
- 若成功提取到 `illustId`：
  - `metascraperRules.image`: 返回 `https://pixiv.cat/${illustId}.jpg`。
  - `metascraperRules.fallbackImage`: 从 Cheerio `htmlDom` 提取 `meta[property="og:image"]` 或 `meta[property="twitter:image"]`。
- 若未提取到（非作品链接）：两者均返回 `undefined`，由通用 `metascraperImage` 兜底。

### 5.2 契约扩展 (Contracts)
1. `LinkPreviewSites.ts`:
   - `SiteCustomizer.metascraperRules` 增加可选的 `fallbackImage` 规则。
   - `siteMetascraperPlugin` 导出 `fallbackImage` 规则。
2. `LinkPreview.ts`:
   - `PageMetadata` 增加 `readonly fallbackImage?: string`。
   - `FormattedPreview` 增加 `readonly fallbackImage?: string`。
   - `formatPreview`: 传递首选图片的 `fallbackImage`。
   - `prepareOutgoingImage(imageUrl: string, fallbackImageUrl?: string, ...)`：若 `imageUrl` 下载失败且 `fallbackImageUrl` 存在，打印 warning 并尝试拉取 `fallbackImageUrl`。

---

## 6. 构建验证与测试计划 (Verification)

1. **单元测试 (`LinkPreviewSites.test.ts`)**：
   - 验证各种 Pixiv 作品链接（`/artworks/82775556`、`/en/artworks/82775556`、`/member_illust.php?mode=medium&illust_id=82775556`）正确提取并生成 `https://pixiv.cat/82775556.jpg`。
   - 验证非作品链接（如 `/users/12345`）不被劫持，返回 `undefined`。
   - 验证 `fallbackImage` 正确提取原始 `og:image`。
2. **下载与降级测试 (`LinkPreview.test.ts`)**：
   - 使用 `makeTestHttpClient` 模拟 pixiv.cat 响应 200，验证返回 pixiv.cat 的图片 Base64。
   - 模拟 pixiv.cat 响应 404，`og:image` 响应 200，验证成功降级并返回 `og:image` 的图片 Base64。
   - 模拟两者皆失败，验证平稳降级为文本预览。
3. **质量检查**：
   - `bun run check` (TypeScript 类型检查)
   - `bun run lint` (Oxlint 静态检查)
   - `bun test` (完整测试套件通过)
