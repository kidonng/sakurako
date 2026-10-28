# SnowLuma QQ 机器人基础与“喵喵喵”功能设计

## 目标与背景 (Intent & Why)

使用 SnowLuma SDK（`@snowluma/sdk`）与 Effect 4（`@effect/platform-bun`、`effect`）开发 QQ 机器人 Sakurako。
SnowLuma 后端已通过 OrbStack 部署在 `snowluma.orb.local`。
首个功能目标：接入 OneBot WebSocket 事件流，当接收到严格匹配“喵喵喵”的群聊或私聊消息时，自动使用普通消息回复“喵喵喵”。

## 目标、非目标与反向目标 (Goals, Non-Goals, Anti-Goals)

- **目标 (Goals)**：
  1. 通过 `.env` 与 `.env.example` 规范配置管理（支持 Bun 自动加载环境变量，包含 WebSocket URL 与 Access Token）。
  2. 基于 Effect 4 的 `Context.Service` 封装 `SnowLumaClient` 服务，使用 `Layer.scoped` 和 `Effect.acquireRelease` 管理生命周期（连接与安全断开）。
  3. 将 OneBot 消息事件桥接为 Effect `Stream`，实现结构化并发与优雅终止。
  4. 实现消息监听与严格全匹配（`raw_message === "喵喵喵"`），同时支持群聊与私聊，通过 `ctx.reply("喵喵喵")` 发送普通回复。
  5. 提供 `src/index.ts` 入口并支持 Bun 运行与 TypeScript 类型检查。
- **非目标 (Non-Goals)**：
  - 本期暂不引入复杂的指令系统或外部插件系统。
  - 本期暂不实现 HTTP API 调用（专注 WebSocket 统一处理双向通信）。
- **反向目标 (Anti-Goals)**：
  - 避免将业务代码直接耦合在底层 EventEmitter 回调中，避免绕过 Effect 运行时调度。
  - 避免将 Access Token 硬编码在代码仓库中。

## 约束 (Constraints)

- Node/Bun ESM 规范，遵循现有 `tsconfig.json` 配置（`verbatimModuleSyntax: true`, `moduleResolution: "bundler"`, `noEmit: true`）。
- 遵循 Effect 4 开发最佳实践（`Effect.gen`、`Context.Service`、`Layer`、`Config`）。
- 环境变量保存在 `.env`（由 Bun 自动读取），并提供 `.env.example`。

## 技术方案对比 (Approaches)

1. **方案 A：基于 Effect Stream 的解耦架构（选定）**
   - 方式：`SnowLumaClient` 服务管理 WS 连接，并将消息事件通过 `Queue` / `Stream` 暴露给业务消费者；业务处理管道作为独立的 Effect 运行。
   - 权衡：初期增加小量 Stream 桥接逻辑，但提供了最好的扩展性、并发控制与错误隔离。
2. **方案 B：基于 Effect Service 内部直接注册回调**
   - 方式：在 Layer 中直接通过 `client.onMessage` 挂载处理函数，内部调用 `runtime.runFork`。
   - 权衡：虽更贴近 SDK 原始形态，但缺乏 Stream 组合能力，不利于未来多个复杂模块扩展。

**选择**：方案 A。

## 详细架构设计 (Detailed Design)

### 1. 配置模块 (`src/Config.ts`)
使用 Effect 的 `Config` 读取：
- `SNOWLUMA_WS_URL`（默认 `ws://snowluma.orb.local:3001/`）
- `SNOWLUMA_ACCESS_TOKEN`（Redacted / Secret 格式）

提供 `.env.example`：
```bash
SNOWLUMA_WS_URL=ws://snowluma.orb.local:3001/
SNOWLUMA_ACCESS_TOKEN=your_access_token_here
```

### 2. SnowLuma 客户端服务 (`src/SnowLuma.ts`)
- 定义 `SnowLumaClient` 继承 `Context.Service<SnowLumaClient, ...>()`。
- 服务接口提供：
  - `client`: 底层 `SnowLumaWebSocketClient` 实例（用于调用 actions 等）。
  - `messages`: `Stream.Stream<{ event: OneBotMessageEvent; context: SnowLumaEventContextWithQuote<OneBotMessageEvent> }>`
- 实现 `SnowLumaClient.layer`:
  - 通过 `Layer.scoped`，在 `Effect.acquireRelease` 中实例化 `SnowLumaWebSocketClient` 并 `connect()`。
  - 在清理阶段调用 `client.close()` 安全断开连接。
  - 创建一个 Effect `Queue`，通过 `client.onMessage` 将消息放入队列；通过 `Stream.fromQueue` 导出消息流。

### 3. 业务处理器 (`src/EchoBot.ts`)
- 订阅 `SnowLumaClient.messages` 流。
- 过滤条件：`event.raw_message === "喵喵喵"`。
- 执行动作：调用 `context.reply("喵喵喵")`，结合 `Effect.logInfo` 记录接收和回复日志。
- 支持群聊和私聊（SDK 的 `context.reply` 自动处理消息类型匹配与目标 ID）。

### 4. 程序入口 (`src/index.ts`)
- 组合 `SnowLumaClient.layer` 与业务处理器。
- 使用 `@effect/platform-bun` 的 `BunRuntime.runMain` 启动主流程。

## 验证计划 (Verification Plan)

1. **代码检查**：运行 `bun run check`（TypeScript 类型检查）和 `bun run lint`（Oxlint 代码规范）。
2. **真实环境联调**：
   - 启动本地机器人程序，观察 WebSocket 建立连接与认证成功的日志。
   - 验证消息接收与回复：向机器人账号发送“喵喵喵”，观察终端日志并验证收到回复“喵喵喵”。
   - 验证非匹配消息（如“喵喵”、“测试”）不会触发回复。
