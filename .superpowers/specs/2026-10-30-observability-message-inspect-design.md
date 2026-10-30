# 可观测性与消息排查流程设计 (Observability & Message Inspection Design)

## 意图与背景 (Intent & Why)

在机器人的日常开发与问题排查中，经常遇到“只知道聊天消息的部分文字片段，需要查出原始消息的完整元数据（Message ID、发送者信息、CQ码/段列表、群信息等）”的调试需求。同时，Sakurako 现有的处理日志较为分散且缺少消息 ID 标记，不易将运行时行为与底层 OneBot 事件对齐。

本项目旨在完善排查流程文档、提供开箱即用的消息检索脚本，并规范化 Sakurako 的业务日志格式，使开发者能够快速完成“片段定位 -> ID 获取 -> 完整结构溯源”的闭环。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

### 目标 (Goals)
1. **排查流程文档**：在 `docs/troubleshooting.md` 中完整记录排查流程，包括如何在 SnowLuma 容器日志中通过文本片段检索定位事件，以及如何获取完整原始消息。
2. **消息查询工具**：提供轻量脚本 `scripts/inspect-msg.ts`（支持 `bun run inspect-msg <message_id>`），复用 `BotConfig` 配置通过 WebSocket `get_msg` 获取并格式化输出消息元数据。
3. **日志关联改进**：在 `EchoBot`、`LinkPreview`、`Sauce` 等核心处理流程中统一追加 `[msg:<id>] [user:<id>]` 前缀与必要的消息片段，方便在 Sakurako 日志中快速定位消息并反查。

### 非目标 (Non-Goals)
- 在 Sakurako 中全局打印每一条流经的原始消息（SnowLuma 容器控制台已有全量记录，无需重复打屏）。
- 更改 SnowLuma 服务端配置或 Docker 镜像设置。
- 引入数据库持久化聊天记录或构建复杂交互式 TUI。

### 反向目标 (Anti-Goals)
- 避免在 Sakurako 运行日志中打印整条超长消息原文或敏感凭证。
- 避免在辅助脚本中硬编码连接地址或 token，必须统一从 `BotConfig` 读取。

## 方案选型 (Approaches)

在前期方案讨论中，对比了以下三种方式：

1. **方案 A：轻量排查脚本 + 统一日志元数据格式（选中）**
   - 新增 `scripts/inspect-msg.ts` 配合 `package.json` 脚本命令，文档详述排查指引；在现有 feature 日志中补充 `[msg:<id>]` 标识。
   - **优点**：使用门槛低，开箱即用，改动克制，开发体验佳。
2. **方案 B：纯文档说明 + 最小日志修改**
   - 仅写文档，排查完全依赖手动拼写 curl/OneBot 请求或单行命令。
   - **缺点**：缺少统一封装，开发者每次排查都需要手动传递 token、处理 WebSocket 或 HTTP 端口差异。
3. **方案 C：完整诊断 CLI + 中间件式日志追踪**
   - 引入支持全文检索的交互式 CLI 与 Effect 全局日志中间件。
   - **缺点**：过度设计，带来不必要的代码复杂度和维护开销。

## 详细设计 (Detailed Design)

### 1. 消息检索脚本 (`scripts/inspect-msg.ts`)
- **调用方式**：`bun run inspect-msg <message_id>`
- **参数校验**：校验传入参数为合法整数（OneBot 消息 ID 支持正负整数）。参数缺失或非法时输出使用提示并退出（退出码 1）。
- **执行逻辑**：
  - 基于 Effect 4 运行，加载 `BotConfig` 获取 `wsUrl` 和 `accessToken`。
  - 创建并连接临时 `SnowLumaWebSocketClient`。
  - 调用 `ws.request("get_msg", { message_id })`。
  - 返回成功时，按格式高亮/缩进打印消息元数据（时间、群/私聊、发送者昵称与账号、原始消息文本、段列表）。
  - 若消息不存在或调用失败，捕获错误并友好输出原因。
  - 关闭连接并安全退出。
- **配置扩展**：在 `package.json` 的 `scripts` 中增加 `"inspect-msg": "bun scripts/inspect-msg.ts"`。

### 2. 日志规范化改进
在三个核心功能 handler 中，统一在命中处理的第一时间输出规范化标识：

- **`EchoBot.ts`**：
  ```ts
  Effect.logInfo(`[msg:${event.message_id}] [user:${event.user_id}] Received '喵喵喵' (${event.message_type}), replying...`)
  ```
- **`LinkPreview.ts`**：
  - 获取原消息截短预览（限制在 30 字符宽度内，超长追加 `...`）。
  ```ts
  Effect.logInfo(`[msg:${event.message_id}] [user:${event.user_id}] Found ${urls.length} URL(s) in message "${snippet}", scraping preview...`)
  ```
- **`Sauce.ts`**：
  ```ts
  Effect.logInfo(`[msg:${event.message_id}] [user:${event.user_id}] Received '/sauce' referencing quoted message ${messageId}...`)
  ```

### 3. 排查指南文档 (`docs/troubleshooting.md`)
- 记录典型的日常排查场景：**持有部分文本 -> 定位原始消息**：
  1. **步骤一：检索片段与获取 Message ID**
     - 使用 `docker logs snowluma | grep "<关键词>"`，展示 SnowLuma 日志示例，说明如何从中提取 `ID:<message_id>`。
  2. **步骤二：查询完整元数据**
     - 执行 `bun run inspect-msg <message_id>`，展示命令输出及关键字段说明（如 CQ 码、段数据、发送者角色等）。
  3. **步骤三：关联 Sakurako 运行日志**
     - 说明 Sakurako 业务日志中的 `[msg:<message_id>]` 标识如何与 SnowLuma 日志及 `inspect-msg` 联动定位问题。

## 留给实现者的细节 (Left to the Builder)
- 脚本中控制台输出的排版美化（格式化 JSON 输出）。
- 确保 `TextWidth.truncate` 在日志片段截短中的复用。
- 确保新脚本与文档符合项目的类型检查、Oxlint 和格式化规范。
