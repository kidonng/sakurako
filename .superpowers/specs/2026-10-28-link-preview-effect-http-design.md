# 链接预览迁移至 effect/http 与 Tagged Error 错误模型重构设计

## 目标与背景 (Intent & Why)

当前 `src/LinkPreview.ts` 使用全局 `fetch` 进行网页元数据抓取和图片下载。为了支持测试，各抓取函数通过参数向下透传可选的 `fetchFn: typeof fetch = fetch`。这导致：
1. 产生参数下钻（prop-drilling），破坏了 Effect 服务环境（Context / Layer）的统一范式。
2. 在单元测试中，多处测试用例被迫使用 `mockFetch as unknown as typeof fetch` 双重断言，绕过类型检查。
3. 抓取失败采用宽泛的 `string` 原因，缺乏强类型区分，导致测试断言只能依赖脆弱的字符串匹配（如 `toContain("HTTP 404")`）。

本重构将使用 `effect/http` 的 `HttpClient` 替换全局 `fetch`，并将抓取失败重构为结构化的扁平 Tagged Errors，提升架构纯粹性、类型安全性与测试人体工学。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. **服务化注入**：`scrapeMetadata`、`prepareOutgoingImage`、`scrapeAll` 与 `handleLinkPreviewMessage` 依赖 `HttpClient.HttpClient` 上下文，彻底移除 `fetchFn` 参数。
  2. **生产环境集成**：在应用入口 `src/index.ts` 中通过 `FetchHttpClient.layer` 向运行时提供 HTTP 客户端。
  3. **领域 Tagged Error 重构（方案 A）**：
     - `InvalidUrlError`: URL 格式不合法。
     - `BlockedHostError`: 目标主机命中回环、内网或非全局 IP 等 SSRF 防护规则。
     - `HttpFetchError`: 网络异常、超时或非 2xx HTTP 状态码（保留状态码与错误信息）。
     - `ParseMetadataError`: Metascraper 或 HTML 解析阶段异常。
     - 联合类型 `type ScrapeMetadataError = InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError`。
  4. **错误消息格式化**：每个错误提供人类可读的 `message`（如 `HTTP 404 Not Found`、`Blocked private or local address`），`formatPreview` 在展示多链接失败提示时读取 `error.message`。
  5. **流式与原生 Effect 简化**：利用 `HttpClientResponse` 原生的 `text` 与 `arrayBuffer` Effect，配合 `Effect.timeout("10 seconds")` 实现中断与超时管理。
  6. **测试人体工学**：在测试中通过 `HttpClient.make` 或辅助层提供 Mock Client，移除所有 `as unknown as typeof fetch` 断言，并支持按 `_tag` 精确断言。

- **非目标 (Non-Goals)**：
  - 不修改 URL 提取正则与逻辑（`extractUrls`）。
  - 不修改站点定制规则（`LinkPreviewSites.ts`）与文本截断算法（`TextWidth.ts`）。
  - 不修改 OneBot 消息发送与引用逻辑。

- **反向目标 (Anti-Goals)**：
  - 避免破坏重定向处理（`response.url` 必须正确反映重定向后的目标地址，供 Metascraper 解析相对路径）。
  - 避免暴露冗长未经清洗的技术堆栈至 QQ 预览回复文本中。

## 约束 (Constraints)

- 遵循 Effect 4 规范与项目既有规范（`Data.TaggedError`、`verbatimModuleSyntax: true`）。
- 严格无 `any` 规则。
- 遵循 Linux Kernel 风格 Commit 提交信息。

## 方案对比与选择 (Approaches)

- **方案 A（已选）：扁平领域 Tagged Errors**
  - **实现**：定义细分的 `InvalidUrlError`、`BlockedHostError`、`HttpFetchError`、`ParseMetadataError`，直接作为 `scrapeMetadata` 的失败通道；`ScrapingResult.Failure` 携带 `error: ScrapeMetadataError`。
  - **权衡**：错误语义清晰，测试中可直接按 `_tag` 匹配断言；需要适度调整 `formatPreview` 及测试代码对错误的解构方式。
- **方案 B：单一 `ScrapeError` 容器包裹底层原因**
  - **实现**：仅定义一个 `ScrapeError`，将各阶段原因挂在 `cause` 上，顶层保留 `reason: string` 兼容字段。
  - **权衡**：对既有代码改动小，但存在嵌套解构，模式匹配不如扁平 Tagged Error 自然。
- **方案 C：直接透传 `HttpClientError`**
  - **实现**：HTTP 错误直接使用 `HttpClientError.HttpClientError`，仅非 HTTP 错误使用自定义 Tagged Error。
  - **权衡**：少写一个错误类，但 `HttpClientError` 文本冗长且技术细节暴露过多，不适合直接展示在用户界面。

## 决策细节 (Decisions)

1. **Tagged Error 定义**：
   使用 `Data.TaggedError` 定义错误类：
   ```ts
   export class InvalidUrlError extends Data.TaggedError("InvalidUrlError")<{
     readonly url: string;
     readonly cause: unknown;
   }> {
     get message(): string {
       return `Invalid URL: ${String(this.cause)}`;
     }
   }

   export class BlockedHostError extends Data.TaggedError("BlockedHostError")<{
     readonly url: string;
     readonly hostname: string;
   }> {
     readonly message = "Blocked private or local address";
   }

   export class HttpFetchError extends Data.TaggedError("HttpFetchError")<{
     readonly url: string;
     readonly status?: number;
     readonly statusText?: string;
     readonly detail: string;
   }> {
     get message(): string {
       if (this.status !== undefined) {
         return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
       }
       return `Network error: ${this.detail}`;
     }
   }

   export class ParseMetadataError extends Data.TaggedError("ParseMetadataError")<{
     readonly url: string;
     readonly cause: unknown;
   }> {
     get message(): string {
       return `Failed to parse metadata: ${String(this.cause)}`;
     }
   }

   export type ScrapeMetadataError =
     | InvalidUrlError
     | BlockedHostError
     | HttpFetchError
     | ParseMetadataError;
   ```

2. **`ScrapingResult` 结构调整**：
   ```ts
   export type ScrapingResult =
     | { readonly _tag: "Success"; readonly data: PageMetadata }
     | { readonly _tag: "Failure"; readonly url: string; readonly error: ScrapeMetadataError };
   ```
   在 `formatPreview` 中：
   ```ts
   if (item._tag === "Failure") {
     blocks.push(`${num}. [提取失败：${item.error.message}]`);
   }
   ```

3. **HTTP 抓取逻辑重构**：
   - 使用 `HttpClient.HttpClient`：
     ```ts
     const client = yield* HttpClient.HttpClient;
     const request = HttpClientRequest.get(url).pipe(
       HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)),
     );
     const response = yield* client.execute(request).pipe(
       Effect.timeout("10 seconds"),
       Effect.mapError((err) => new HttpFetchError({ url, detail: err.message })),
     );
     if (response.status < 200 || response.status >= 300) {
       return yield* Effect.fail(
         new HttpFetchError({
           url,
           status: response.status,
           statusText: (response.raw as Response | undefined)?.statusText,
           detail: `HTTP status ${response.status}`,
         }),
       );
     }
     const html = yield* response.text.pipe(
       Effect.mapError((err) => new HttpFetchError({ url, detail: `Failed to read response body: ${err.message}` })),
     );
     ```
   - 重定向目标保留：`const targetUrl = response.url || url;`

4. **`prepareOutgoingImage` 重构**：
   - 同样通过 `HttpClient.HttpClient` 下载图片 ArrayBuffer：
     ```ts
     const response = yield* client.execute(request).pipe(Effect.timeout("10 seconds"));
     if (response.status < 200 || response.status >= 300) {
       throw new Error(`HTTP ${response.status}`);
     }
     const buffer = yield* response.arrayBuffer;
     const base64 = Buffer.from(buffer).toString("base64");
     return `base64://${base64}`;
     ```

5. **测试辅助工具**：
   在测试文件中构造通用 Layer：
   ```ts
   function makeTestHttpClient(
     handler: (request: HttpClientRequest.HttpClientRequest) => Response | Promise<Response>,
   ) {
     return Layer.succeed(
       HttpClient.HttpClient,
       HttpClient.make((request) =>
         Effect.tryPromise(async () =>
           HttpClientResponse.fromWeb(request, await handler(request)),
         ),
       ),
     );
   }
   ```
   测试中调用：
   ```ts
   const program = scrapeMetadata("https://example.com").pipe(
     Effect.provide(makeTestHttpClient(() => new Response("...", { status: 200 }))),
   );
   ```

6. **生产入口配置**：
   在 `src/index.ts` 中：
   ```ts
   const MainLive = MainProgram.pipe(
     Effect.provide(SnowLumaClient.layer),
     Effect.provide(FetchHttpClient.layer),
   );
   ```

## 留给构建者的细节 (Left to Builder)

- 测试用例断言的对应更新（将原有的 `expect(error).toContain(...)` 升级为对 `_tag` 与 `message` 的检查）。
- 确认是否需要在测试辅助工具中默认拦截未匹配的请求。
