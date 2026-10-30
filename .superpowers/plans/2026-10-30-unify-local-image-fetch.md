# 链接预览统一本地抓取图片与安全防护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一链接预览图片为本地抓取并以 Base64 发送（默认行为），重命名 `sendImageAsBase64` 为 `fetchImageLocally`，并在抓取阶段实施大小上限 (10 MB) 与 `Content-Type: image/*` 媒体类型校验防护。

**Architecture:** 在 `LinkPreviewSites.ts` 中将站点定制项重构为面向行为的 `fetchImageLocally`，默认对所有 URL 返回 `true`；在 `LinkPreview.ts` 的 `prepareOutgoingImage` 中加入 HTTP 头与响应体积安全门控，自动将异常或超限响应降级为文本预览。

**Tech Stack:** TypeScript 7, Effect 4 (`effect`, `@effect/platform`), Bun 1.4.x, bun:test

**Spec:** `.superpowers/specs/2026-10-30-unify-local-image-fetch-design.md`

## Global Constraints

- Linux Kernel commit message style for git commits.
- Strict `no any` policy; type annotations conform to `verbatimModuleSyntax`.
- Use Effect-native constructs (`Data.TaggedError`, `Effect.gen`, `HttpClient`).
- Must pass `bun test`, `bun run check` (tsc), and `bun run lint` (oxlint).

## Review Focus

1. **Content-Type 带参数**: 如 `Content-Type: image/jpeg; charset=utf-8`，需正确提取 MIME 主体判断。
2. **缺少 Content-Length 头 (Chunked)**: 动态生成的流无 Content-Length，需在读取 buffer 后验证其 byteLength 是否超限。
3. **恶意或误报 HTML 响应**: 返回 200 OK 但内容是 HTML 拦截页，Content-Type 校验必须拦截。
4. **SVG 图片格式**: `image/svg+xml` 虽是 image/*，但 QQ NT 不支持，必须明确过滤并降级。
5. **显式 opt-out**: 配置了 `fetchImageLocally: false` 的自定义站点必须正确保留原始 URL 交付给 SnowLuma。

---

### Task 1: 命名重构与默认值调整 (`LinkPreviewSites.ts`)

**Files:**
- Modify: `src/features/link-preview/LinkPreviewSites.ts`
- Modify: `src/features/link-preview/LinkPreview.ts` (同步引用)
- Test: `test/features/link-preview/LinkPreviewSites.test.ts`

**Interfaces:**
- Consumes: `findSiteCustomizer(rawUrl)`
- Produces:
  ```ts
  export interface SiteCustomizer {
    readonly name: string;
    readonly match: (url: URL) => boolean;
    readonly userAgent?: string;
    readonly fetchImageLocally?: boolean;
    // ...
  }
  export function shouldFetchImageLocally(rawUrl: string | URL): boolean;
  ```

- [ ] **Step 1: Write failing test in `LinkPreviewSites.test.ts`**
  更新 `shouldSendImageAsBase64` 为 `shouldFetchImageLocally` 测试用例：
  - 对通用 URL 默认返回 `true`；
  - 对匹配 `fetchImageLocally: false` 的自定义站点返回 `false`；
  - 验证 `danbooruCustomizer` 默认不再强制指定 `fetchImageLocally`，但其判定依然为 `true`。

- [ ] **Step 2: Run test to verify failure**
  Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
  Expected: FAIL (`shouldFetchImageLocally is not defined` 或命名不匹配)

- [ ] **Step 3: Implement renaming and default value in `LinkPreviewSites.ts` and `LinkPreview.ts`**
  - 在 `LinkPreviewSites.ts` 中重命名 `sendImageAsBase64` 为 `fetchImageLocally`；
  - 实现 `shouldFetchImageLocally(rawUrl: string | URL): boolean`，返回 `customizer?.fetchImageLocally ?? true`；
  - 从 `danbooruCustomizer` 中删除显式的 `sendImageAsBase64: true`；
  - 同步更新 `LinkPreview.ts` 中的导入与调用。

- [ ] **Step 4: Run test to verify pass**
  Run: `bun test test/features/link-preview/LinkPreviewSites.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/features/link-preview/LinkPreviewSites.ts src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewSites.test.ts
  git commit -m "link-preview: Rename sendImageAsBase64 to fetchImageLocally and enable by default"
  ```

---

### Task 2: 实施图片体积与 Content-Type 防护 (`LinkPreview.ts`)

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewEngine.test.ts`

**Interfaces:**
- Consumes: `shouldFetchImageLocally(imageUrl)`, `HttpClient`
- Produces:
  ```ts
  export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
  export class FetchImageError extends Data.TaggedError("FetchImageError")<{
    readonly cause: unknown;
  }> {}
  export function prepareOutgoingImage(
    imageUrl: string,
    timeoutDuration?: Duration.Input,
  ): Effect.Effect<string | undefined, never, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write failing tests in `LinkPreviewEngine.test.ts`**
  在 `describe("prepareOutgoingImage")` 中补充用例：
  - 默认对普通图片 URL 进行本地抓取并转为 Base64；
  - 当站点显式配置 `fetchImageLocally: false` 时，保留原始 URL；
  - 当 `Content-Length` 超过 10 MB 时，返回 `undefined` 并中止下载；
  - 当响应体超过 10 MB（未声明 Content-Length）时，返回 `undefined`；
  - 当 `Content-Type` 为 `text/html`、`application/json` 或缺失时，返回 `undefined`；
  - 当 `Content-Type` 为 `image/svg+xml` 时，返回 `undefined`；
  - 正常 `image/png`、`image/jpeg; charset=utf-8` 正确通过。

- [ ] **Step 2: Run tests to verify failures**
  Run: `bun test test/features/link-preview/LinkPreviewEngine.test.ts`
  Expected: FAIL (新防护用例失败)

- [ ] **Step 3: Implement protection logic in `prepareOutgoingImage`**
  - 重命名 `DownloadImageAsBase64Error` 为 `FetchImageError`；
  - 定义 `export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;`；
  - 检查 HTTP 状态码后：
    - 读取 `response.headers["content-type"]`，按 `;` 分割并 trim 取 MIME 类型；若不以 `image/` 开头或为 `image/svg+xml`，记录 warning，取消 body 流，返回 `undefined`；
    - 读取 `response.headers["content-length"]`，若存在且解析为数字 `> MAX_IMAGE_BYTES`，记录 warning，取消 body 流，返回 `undefined`；
  - 读取 `arrayBuffer` 后：
    - 检查 `buffer.byteLength > MAX_IMAGE_BYTES`，若超限记录 warning，返回 `undefined`；
  - 编码为 `base64://${base64}` 返回。

- [ ] **Step 4: Run tests to verify pass**
  Run: `bun test test/features/link-preview/LinkPreviewEngine.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewEngine.test.ts
  git commit -m "link-preview: Enforce size limit and Content-Type validation for local image fetching"
  ```

---

### Task 3: 文档更新与全量验证

**Files:**
- Modify: `docs/features/link-preview.md` (或相关文档)

- [ ] **Step 1: Update documentation**
  更新文档中关于图片抓取策略的描述（默认统一本地抓取并以 Base64 发送，具备 10MB 体积与 Content-Type 防护）。

- [ ] **Step 2: Run full verification suite**
  Run: `bun test`
  Run: `bun run check`
  Run: `bun run lint`
  Expected: 全部 PASS，0 错误，0 警告。

- [ ] **Step 3: Commit**
  ```bash
  git add docs/features/link-preview.md
  git commit -m "docs: Update link preview image delivery and protection documentation"
  ```
