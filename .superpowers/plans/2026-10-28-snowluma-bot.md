# SnowLuma QQ 机器人与“喵喵喵”功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 SnowLuma SDK 与 Effect 4 构建 QQ 机器人基础服务，并通过 Effect Stream 实现群聊与私聊“喵喵喵”严格全匹配回复。

**Architecture:** 使用 Effect `Config` 读取环境变量；基于 `Context.Service` 与 `Layer.scoped` 管理 `SnowLumaWebSocketClient` 的连接生命周期；通过 `Queue` 与 `Stream` 暴露类型安全的消息流；在业务层处理严格匹配并触发普通回复；最后在 `src/index.ts` 通过 `BunRuntime.runMain` 启动。

**Tech Stack:** TypeScript 7.0, Bun, Effect 4.0.6, `@effect/platform-bun`, `@snowluma/sdk` 2.2.1

**Spec:** `.superpowers/specs/2026-10-28-snowluma-bot-design.md`

## Global Constraints

- 严守 `tsconfig.json`（`verbatimModuleSyntax: true`, `moduleResolution: "bundler"`, `noEmit: true`）。
- 遵循 Effect 4 开发规范（`Effect.gen`、`Context.Service`、`Layer`、`Config`，避免直接在未管理的非 Effect 回调中处理复杂业务状态）。
- Git 提交信息遵循 Linux Kernel 风格（Header 带 scope，包含 `### Problem`、`### Solution`、`### References` 段落）。
- 环境变量保存在 `.env`，提供 `.env.example` 模版，不得将敏感 Token 提交到 Git。

## Review Focus

1. 包含空格或换行的消息（例如 `" 喵喵喵 "` 或 `"喵喵喵\n"`）不应触发回复（严格全匹配 `raw_message === "喵喵喵"`）。
2. 非文本消息或空消息（如图片、纯表情、撤回通知）不会导致程序抛错崩溃。
3. WebSocket 连接断开或异常关闭时，`Scope` 正确释放底层资源并避免 Fiber 泄漏。
4. 机器人自己发送的“喵喵喵”消息不会导致死循环自我响应（OneBot 默认未开启 `reportSelfMessage`，且业务层也可防护）。
5. 缺失 `SNOWLUMA_ACCESS_TOKEN` 时，配置加载应给出明确的 Effect ConfigError，而非运行时隐式失败。

---

### Task 1: 配置模块与环境变量模版

**Files:**
- Create: `.env.example`
- Create: `.env` (gitignored if not already)
- Create: `src/Config.ts`
- Test: `test/Config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BotConfig {
    readonly wsUrl: string
    readonly accessToken: Redacted.Redacted<string>
  }
  export const BotConfig: Config.Config<BotConfig>
  ```

- [ ] **Step 1: 编写配置单元测试**

在 `test/Config.test.ts` 中测试 `BotConfig` 的默认值与环境变量解析行为。

```ts
import { Config, ConfigProvider, Effect, Redacted } from "effect"
import { describe, expect, it } from "bun:test"
import { BotConfig } from "../src/Config.ts"

describe("BotConfig", () => {
  it("loads configuration from environment provider", async () => {
    const provider = ConfigProvider.fromMap(
      new Map([
        ["SNOWLUMA_WS_URL", "ws://127.0.0.1:3001/"],
        ["SNOWLUMA_ACCESS_TOKEN", "test-token"]
      ])
    )

    const program = Config.unwrap(BotConfig).pipe(
      Effect.withConfigProvider(provider)
    )

    const result = await Effect.runPromise(program)
    expect(result.wsUrl).toBe("ws://127.0.0.1:3001/")
    expect(Redacted.value(result.accessToken)).toBe("test-token")
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

运行: `bun test test/Config.test.ts`
预期: FAIL，因为 `src/Config.ts` 尚未创建。

- [ ] **Step 3: 实现 `.env.example`、`.env` 与 `src/Config.ts`**

创建 `.env.example`：
```bash
SNOWLUMA_WS_URL=ws://snowluma.orb.local:3001/
SNOWLUMA_ACCESS_TOKEN=your_token_here
```

创建 `.env`（写入实际凭据 `ws://snowluma.orb.local:3001/` 与 `UVP8Izn6ZEe1xbDHa0hhNQn_znB7KTZWJRM254PMXEY`）。
在 `.gitignore` 中确保 `.env` 被忽略（保留 `.env.example`）。

在 `src/Config.ts` 中使用 `Config.string` 与 `Config.redacted` 实现 `BotConfig`。

- [ ] **Step 4: 运行测试验证通过**

运行: `bun test test/Config.test.ts`
预期: PASS。

- [ ] **Step 5: 提交代码**

```bash
git add .gitignore .env.example src/Config.ts test/Config.test.ts
git commit -m "config: add BotConfig and environment template

### Problem

The bot needs WebSocket connection URL and access token configuration to
connect to the SnowLuma backend without hardcoding credentials in source code.

### Solution

Introduce BotConfig using Effect's Config module to safely read configuration
with Redacted token support, and add .env.example template.

### References

.superpowers/specs/2026-10-28-snowluma-bot-design.md"
```

---

### Task 2: 封装 SnowLuma 客户端 Service 与消息事件 Stream

**Files:**
- Create: `src/SnowLuma.ts`
- Test: `test/SnowLuma.test.ts`

**Interfaces:**
- Consumes: `BotConfig` from `src/Config.ts`
- Produces:
  ```ts
  export interface IncomingMessage {
    readonly event: OneBotMessageEvent
    readonly context: SnowLumaEventContextWithQuote<OneBotMessageEvent>
  }

  export class SnowLumaClient extends Context.Service<SnowLumaClient, {
    readonly client: SnowLumaWebSocketClient
    readonly messages: Stream.Stream<IncomingMessage>
  }>()("sakurako/SnowLumaClient") {
    static readonly layer: Layer.Layer<SnowLumaClient, ConfigError>
  }
  ```

- [ ] **Step 1: 编写 SnowLumaClient 结构与 Queue 桥接测试**

在 `test/SnowLuma.test.ts` 中测试消息流接收行为：

```ts
import { describe, expect, it } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import type { IncomingMessage } from "../src/SnowLuma.ts"

describe("SnowLumaClient message stream bridge", () => {
  it("emits incoming messages from queue to stream", async () => {
    const queue = await Effect.runPromise(Queue.unbounded<IncomingMessage>())
    const stream = Stream.fromQueue(queue)

    const mockItem = {
      event: { raw_message: "喵喵喵", message_type: "group", user_id: 12345 } as any,
      context: { reply: async () => {} } as any
    }

    await Effect.runPromise(Queue.offer(queue, mockItem))
    const item = await Effect.runPromise(Stream.runHead(stream))
    expect(item._tag).toBe("Some")
    if (item._tag === "Some") {
      expect(item.value.event.raw_message).toBe("喵喵喵")
    }
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

运行: `bun test test/SnowLuma.test.ts`
预期: FAIL，`src/SnowLuma.ts` 尚未创建。

- [ ] **Step 3: 实现 `src/SnowLuma.ts`**

在 `src/SnowLuma.ts` 中：
1. 继承 `Context.Service<SnowLumaClient, ...>()("sakurako/SnowLumaClient")`。
2. 在 `Layer.scoped` 中：
   - 读取 `BotConfig`。
   - 创建 `Queue.unbounded<IncomingMessage>()`。
   - 使用 `Effect.acquireRelease` 初始化 `SnowLumaWebSocketClient`，挂载 `client.onMessage((event, context) => ...)` 将消息放入队列。
   - 在 acquire 成功后调用 `client.connect()` 并记录日志，release 时调用 `client.close()` 并关闭队列。
   - 导出 `messages: Stream.fromQueue(queue)`。

- [ ] **Step 4: 运行测试验证通过**

运行: `bun test test/SnowLuma.test.ts`
预期: PASS。

- [ ] **Step 5: 提交代码**

```bash
git add src/SnowLuma.ts test/SnowLuma.test.ts
git commit -m "snowluma: encapsulate SnowLuma client as Effect service with message stream

### Problem

Directly using WebSocket callbacks bypasses Effect's lifecycle and structured
concurrency guarantees, making error handling and resource cleanup fragile.

### Solution

Define SnowLumaClient as a Context.Service managed within a scoped Layer using
Effect.acquireRelease, bridging WebSocket message events into an Effect Stream.

### References

.superpowers/specs/2026-10-28-snowluma-bot-design.md"
```

---

### Task 3: 实现消息严格匹配与回复逻辑 (`EchoBot`)

**Files:**
- Create: `src/EchoBot.ts`
- Test: `test/EchoBot.test.ts`

**Interfaces:**
- Consumes: `SnowLumaClient` from `src/SnowLuma.ts`
- Produces:
  ```ts
  export const handleIncomingMessage: (
    item: IncomingMessage
  ) => Effect.Effect<void, unknown>

  export const runEchoBot: Effect.Effect<void, never, SnowLumaClient>
  ```

- [ ] **Step 1: 编写消息匹配与回复逻辑测试**

在 `test/EchoBot.test.ts` 中测试：
- 当 `raw_message === "喵喵喵"` 时调用 `reply("喵喵喵")`。
- 当 `raw_message` 为其他内容（如 `" 喵喵喵 "`、`"喵喵"`、`"hello"`）时不调用 `reply`。

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { handleIncomingMessage } from "../src/EchoBot.ts"
import type { IncomingMessage } from "../src/SnowLuma.ts"

describe("handleIncomingMessage", () => {
  it("replies with 喵喵喵 when raw_message is strictly 喵喵喵", async () => {
    let replied: string | null = null
    const item: IncomingMessage = {
      event: { raw_message: "喵喵喵", message_type: "group", user_id: 10001 } as any,
      context: {
        reply: async (msg: string) => {
          replied = msg
        }
      } as any
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(replied).toBe("喵喵喵")
  })

  it("does not reply when message does not strictly match", async () => {
    let called = false
    const item: IncomingMessage = {
      event: { raw_message: " 喵喵喵 ", message_type: "private", user_id: 10001 } as any,
      context: {
        reply: async () => {
          called = true
        }
      } as any
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(called).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

运行: `bun test test/EchoBot.test.ts`
预期: FAIL，`src/EchoBot.ts` 尚未创建。

- [ ] **Step 3: 实现 `src/EchoBot.ts`**

在 `src/EchoBot.ts` 中：
1. 实现 `handleIncomingMessage`:
   - 检查 `item.event.raw_message === "喵喵喵"`。
   - 若匹配，调用 `Effect.promise(() => item.context.reply("喵喵喵"))` 并打印结构化日志 `Effect.logInfo(...)`。
   - 若不匹配，返回 `Effect.void`。
2. 实现 `runEchoBot`:
   - 获取 `SnowLumaClient`。
   - `client.messages.pipe(Stream.runForEach(handleIncomingMessage))`。

- [ ] **Step 4: 运行测试验证通过**

运行: `bun test test/EchoBot.test.ts`
预期: PASS。

- [ ] **Step 5: 提交代码**

```bash
git add src/EchoBot.ts test/EchoBot.test.ts
git commit -m "bot: implement exact match echo handler for 喵喵喵

### Problem

The bot needs to respond to messages strictly matching '喵喵喵' with '喵喵喵'
in both group and private chats while ignoring any other messages.

### Solution

Implement handleIncomingMessage and runEchoBot to filter messages with
exact equality check and invoke context.reply('喵喵喵') with structured logs.

### References

.superpowers/specs/2026-10-28-snowluma-bot-design.md"
```

---

### Task 4: 程序入口与联调验证

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` (添加 start 脚本)

**Interfaces:**
- Consumes: `SnowLumaClient.layer`, `runEchoBot`
- Produces: 应用程序主入口，启动长期运行的机器人服务。

- [ ] **Step 1: 编写 `src/index.ts`**

```ts
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { runEchoBot } from "./EchoBot.ts"
import { SnowLumaClient } from "./SnowLuma.ts"

const MainLive = runEchoBot.pipe(
  Effect.provide(SnowLumaClient.layer)
)

BunRuntime.runMain(MainLive)
```

- [ ] **Step 2: 更新 `package.json` 添加 `start` 脚本**

在 `package.json` 的 `scripts` 中添加 `"start": "bun src/index.ts"`。

- [ ] **Step 3: 运行代码规范与类型检查**

运行:
```bash
bun run check
bun run lint
```
预期: 0 errors, 全部通过。

- [ ] **Step 4: 运行所有单元测试**

运行: `bun test`
预期: 全部通过。

- [ ] **Step 5: 真实后端连接与消息联调**

编写临时脚本或直接启动 `bun src/index.ts`，验证：
1. 控制台成功输出已连接到 `ws://snowluma.orb.local:3001/`。
2. 通过 SDK HTTP 接口或 QQ 客户端发送测试消息，验证能够收到并正常响应。

- [ ] **Step 6: 提交代码**

```bash
git add src/index.ts package.json
git commit -m "app: add main entry point and start script

### Problem

The application needs an entry point to wire together SnowLumaClient and
EchoBot using BunRuntime.runMain.

### Solution

Create src/index.ts providing SnowLumaClient.layer to runEchoBot and add start
script to package.json.

### References

.superpowers/specs/2026-10-28-snowluma-bot-design.md"
```
