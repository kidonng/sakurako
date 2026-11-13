# Danbooru 可选 API Key 支持与标签上限提升设计

## 背景与目标

Danbooru 在上游提交 `1b08dd4340e2d19679998bd88efb2c932c0417a2` 中将注册成员（Member）的搜索标签上限由 2 个提升至 3 个，匿名访客仍保持 2 个上限。

Sakurako 的 `/dbr` 命令此前硬编码限制最多 2 个标签且仅以匿名方式请求 Danbooru API。本次改动增加可选的 Danbooru API 凭据配置：
- 未配置或凭据不完整时，保持匿名模式与 2 个标签上限；
- 同时配置用户名与 API Key 后，为 Danbooru API 请求附带 HTTP Basic Auth 鉴权，并将 `/dbr` 标签上限提升至 3 个。

## 约束与调研结论

- Danbooru API（`help:api`）不支持单独使用 `api_key` 鉴权，必须同时提供 `login`（用户名）与 `api_key`，支持 URL 查询参数或 HTTP Basic Auth（`Authorization: Basic base64(login:api_key)`）。
- `DanbooruClient` 中默认附加的 `is:sfw` 与 `is:active` 属于 Danbooru `UNLIMITED_METATAGS`，不计入标签上限。
- 现有 `User-Agent: Sakurako/1.0 (user #898759)` 中的 `#898759` 为数字用户 ID，并非 `login` 用户名，仍由配置显式提供。

## 设计方案

1. **配置层（`src/Config.ts`）**：
   - 新增 `DanbooruAuthConfig` 与 `BotConfig` 可选字段 `danbooruLogin`（`DANBOORU_LOGIN`）与 `danbooruApiKey`（`DANBOORU_API_KEY`，`Redacted`），自动去除首尾空白并将空值归一化为 `undefined`。
   - 提供 `resolveDanbooruCredentials`、`hasIncompleteDanbooruCredentials` 与 `getDanbooruTagLimit`（2 或 3）。
2. **API 客户端（`src/features/danbooru/DanbooruClient.ts`）**：
   - `DanbooruClient.layer` 读取 `DanbooruAuthConfig`；当双字段齐备时，在 `getRandomPost` 请求头中注入 `Authorization: Basic ...`。
   - `downloadImage` 不附带 `Authorization` 请求头，避免凭据泄露给图片 CDN。
3. **命令处理与启动日志（`src/features/danbooru/Danbooru.ts`、`src/index.ts`）**：
   - `handleDanbooruMessage` 使用 `getDanbooruTagLimit` 动态校验标签数量并提示 `[标签数量超出限制，最多支持 ${maxTags} 个]`。
   - `logStartupInfo` 输出 Danbooru 鉴权状态（已鉴权上限 3 / 凭据不完整 Warning 降级 / 匿名上限 2）。
