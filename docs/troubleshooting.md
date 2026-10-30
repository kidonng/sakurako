# 故障排查与消息检索指南 (Troubleshooting Guide)

本文档介绍在开发与日常运维 Sakurako 时，如何通过消息片段或日志快速定位原始消息、获取完整 OneBot 元数据，以及如何将 Sakurako 业务日志与底层事件进行关联排查。

## 架构与可观测性分工

- **SnowLuma 容器（底层事件流）**：负责维护 QQ 协议连接，接收并记录所有流经的群聊与私聊消息。SnowLuma 容器控制台输出包含每条消息的时间、群号、发送者、消息 ID 与文本摘要。
- **Sakurako（应用层逻辑）**：通过 WebSocket 订阅事件流，仅在匹配具体业务功能（如 Echo、LinkPreview、Sauce）时处理并记录结构化日志。

---

## 典型排查流程：从文本片段定位原始元数据

当群友反馈某条消息触发异常，或者需要验证某条特定消息在 OneBot 协议中的原始结构（CQ 码、消息段、发送者权限等），但你手头只有消息的部分文字片段时，可通过以下两步快速定位。

### 步骤一：在 SnowLuma 容器日志中检索片段

SnowLuma 的容器日志中会打印所有消息的简要信息。使用 `docker logs` 结合 `grep` 检索关键词：

```bash
docker logs snowluma 2>&1 | grep "关键词片段"
```

输出示例（注：以下均为脱敏演示数据）：

```text
16:30:00 OK    [2840000000] [Event] 群 [测试群(20002)] | [群友A(10001)]: ID:12345678 这是一条包含 https://example.com 的测试消息
```

从中可以提取关键定位信息：

- **时间**：`16:30:00`
- **群号**：`20002`
- **发送者**：`群友A` (`10001`)
- **Message ID**：`12345678`（注意：OneBot 消息 ID 既可能是正整数，也可能是负 32 位有符号整数，如 `-12345678`）

### 步骤二：使用 `inspect-msg` 查询完整消息元数据

获取到 `message_id` 后，运行项目内置的调试工具 `inspect-msg`：

```bash
bun run inspect-msg 12345678
```

该工具会通过当前的机器人配置（`.env` 中的 `SNOWLUMA_WS_URL` 与 `SNOWLUMA_ACCESS_TOKEN`）建立临时连接，调用 OneBot 的 `get_msg` 动作，并输出格式化摘要与完整原始 JSON 结构：

```text
=== Message Metadata ===
Message ID: 12345678
Type: group
Group: 测试群 (20002)
Sender: 群友A (10001)
Time: 2026-10-30T08:30:00.000Z (1793349000)
Raw Message: 这是一条包含 https://example.com 的测试消息

=== Raw JSON Payload ===
{
  "time": 1793349000,
  "message_type": "group",
  "sub_type": "normal",
  "message_id": 12345678,
  "message_seq": 10001,
  "group_id": 20002,
  "group_name": "测试群",
  "user_id": 10001,
  "message": [
    {
      "type": "text",
      "data": {
        "text": "这是一条包含 https://example.com 的测试消息"
      }
    }
  ],
  "raw_message": "这是一条包含 https://example.com 的测试消息",
  "font": 0,
  "sender": {
    "user_id": 10001,
    "nickname": "群友A",
    "card": "",
    "role": "member",
    "sex": "unknown",
    "age": 0
  },
  "anonymous": null,
  "real_id": 12345678
}
```

---

## 关联 Sakurako 业务运行日志

为了方便快速对齐，Sakurako 的各功能 handler 在匹配触发时均采用统一的元数据前缀：

```text
[msg:<message_id>] [user:<user_id>] <操作或上下文>
```

### 日志格式示例

- **链接预览 (LinkPreview)**：
  ```text
  [msg:12345678] [user:10001] Found 1 URL(s) in message "这是一条包含 https://exampl...", scraping preview...
  [msg:12345678] [user:10001] Link preview quote reply sent.
  ```
- **以图搜图 (Sauce)**：
  ```text
  [msg:12345679] [user:10001] Received '/sauce', retrieving quoted message 12345678...
  [msg:12345679] [user:10001] Searching SauceNao for image in message 12345678...
  [msg:12345679] [user:10001] Sauce reply sent successfully.
  ```
- **复读 (EchoBot)**：
  ```text
  [msg:12345680] [user:10001] Received '喵喵喵' (group), replying...
  [msg:12345680] [user:10001] Reply sent: 喵喵喵
  ```

当在 Sakurako 控制台看到错误（例如抓取失败或引用发送失败）时，可以直接复制日志中的 `[msg:<id>]` 中的 ID，执行 `bun run inspect-msg <id>` 即可完整查看原消息上下文与发送者详情。

---

## 常见调试场景

### 1. 链接预览没有发出回复

可能原因与排查步骤：

1. **未提取到有效链接**：检查消息内容是否为标准 `http://` 或 `https://` 链接。
2. **私网/本地地址被拦截**：Sakurako 会主动拒绝抓取内网或局域网 IP（如 `127.0.0.1`、`192.168.x.x`、`10.x.x.x`）。
3. **网页无法抓取或未提供摘要**：若所有链接抓取均失败且无有效标题或图片，机器人会主动保持静默。控制台会输出 `All URL scrapes failed or produced no preview, remaining silent.`。
4. **Jev 决策模型过滤**：若配置了 `OPENROUTER_API_KEY`，模型若判定网页摘要相比原消息无增量信息，单链接将保持静默。

### 2. `/sauce` 提示“未在引用的消息中找到图片”

排查步骤：

1. 使用 `bun run inspect-msg <当前/sauce消息ID>` 确认引用的 `reply` 段中的 `id`（被引用的消息 ID）。
2. 使用 `bun run inspect-msg <被引用的消息ID>` 查看该消息的 `message` 数组，确认是否包含 `type: "image"` 段及有效的图片 URL。
