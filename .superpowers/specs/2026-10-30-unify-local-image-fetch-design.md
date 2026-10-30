# 链接预览统一本地抓取图片与安全防护设计

## 目标与背景 (Intent & Why)

### 问题现状
1. **SnowLuma 远端下载易被拦截**：
   SnowLuma OneBot 网关内部在下载图片时硬编码了桌面 Chrome 的 `User-Agent`，但底层为 Node.js 原生 `fetch`，其 TLS/HTTP2 特征与真实 Chrome 严重不匹配，导致被 Cloudflare（如 Danbooru、Pixiv 代理）、反爬网关等拦截返回 HTTP 403。
2. **缺乏普适性配置与行为抽象**：
   此前针对 Danbooru 临时引入了 `sendImageAsBase64: true` 配置，但该字段名描述的是底层实现细节（Base64 传输），而非业务行为（由 Bot 本地执行抓取）。事实上该问题在多个站点普遍存在。
3. **缺乏防护机制**：
   目前的 `prepareOutgoingImage` 缺乏对异常和恶意图片响应的防御：
   - 未限制图片体积（无 `Content-Length` 预检或 body 截断），存在内存爆炸 (OOM) 风险；
   - 未校验 `Content-Type`，当目标网站返回 200 的 HTML 错误页/验证码页时会被误当作图片二进制发送。

### 解决思路
1. **语义与命名重构**：
   将 `sendImageAsBase64` 重命名为更贴近行为意图的 `fetchImageLocally`，默认值由 `false` 改为 `true`。即：默认对所有链接预览图片统一在 Sakurako 本地抓取并以 Base64 发送；站点定制规则可按需显式 opt-out (`fetchImageLocally: false`)。
2. **安全防护落地**：
   在 `prepareOutgoingImage` 中加入：
   - 最大体积限制（`MAX_IMAGE_BYTES = 10 * 1024 * 1024`，10 MB）：`Content-Length` 预检拦截 + `arrayBuffer` 后验拦截；
   - 媒体类型校验：严格要求 `Content-Type` 为 `image/*`，且排除 QQ 不支持的 `image/svg+xml`；
   - 校验未通过时及时调用 `body.cancel()` 释放流资源并返回 `undefined`（自动优雅降级为纯文本预览）。

---

## 架构与技术设计 (Architecture & Design)

### 1. 命名与接口变更 (`LinkPreviewSites.ts`)

- `SiteCustomizer` 接口变更：
  ```ts
  export interface SiteCustomizer {
    readonly name: string;
    readonly match: (url: URL) => boolean;
    readonly userAgent?: string;
    readonly fetchImageLocally?: boolean;
    readonly metascraperRules?: { ... };
    readonly formatItem?: (context: SiteFormatContext) => SiteFormatOptions;
  }
  ```
- 辅助判定函数：
  ```ts
  export function shouldFetchImageLocally(rawUrl: string | URL): boolean {
    const customizer = findSiteCustomizer(rawUrl);
    return customizer?.fetchImageLocally ?? true;
  }
  ```
- 精简 `danbooruCustomizer`：移除冗余的 `sendImageAsBase64: true`。

### 2. 错误类型与防护实现 (`LinkPreview.ts`)

- 错误模型变更：
  `DownloadImageAsBase64Error` 重命名为 `FetchImageError`：
  ```ts
  export class FetchImageError extends Data.TaggedError("FetchImageError")<{
    readonly cause: unknown;
  }> {}
  ```
- 防护常量：
  ```ts
  export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
  ```
- `prepareOutgoingImage` 流程：
  1. 校验 URL 合法性与 SSRF（`isPrivateHost` 拦截）；
  2. 若 `!shouldFetchImageLocally(imageUrl)`，直接返回原始 `imageUrl`；
  3. 发起 HTTP GET 请求，携带对应的 `User-Agent`；
  4. 检查 HTTP 状态码（200..299）；
  5. 检查响应头 `content-type`：
     - 若未提供或不以 `image/` 开头，或者为 `image/svg+xml`，记录警告日志，取消 body，返回 `undefined`；
  6. 检查响应头 `content-length`：
     - 若存在且为正整数，且 `> MAX_IMAGE_BYTES`，记录警告日志，取消 body，返回 `undefined`；
  7. 读取 `response.arrayBuffer`：
     - 若实际字节数 `buffer.byteLength > MAX_IMAGE_BYTES`，记录警告日志，返回 `undefined`；
  8. 转换为 `base64://${Buffer.from(buffer).toString("base64")}` 返回。

---

## 影响范围与验证策略

### 受影响文件
- `src/features/link-preview/LinkPreviewSites.ts`: 字段重命名与默认值调整。
- `src/features/link-preview/LinkPreview.ts`: 引入常量、防护拦截逻辑、错误重命名。
- `test/features/link-preview/LinkPreviewSites.test.ts`: 测试用例同步更新。
- `test/features/link-preview/LinkPreviewEngine.test.ts`: 补充体积与 Content-Type 校验用例，更新默认抓取断言。
- `docs/features/link-preview.md`: 更新文档说明。

### 验证标准
- `bun test`: 所有测试全部通过。
- `bun run check`: TypeScript 严格类型检查无报错。
- `bun run lint`: Oxlint 无报错。
