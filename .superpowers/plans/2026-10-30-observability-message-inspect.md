# Observability & Message Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide end-to-end message troubleshooting tooling, documentation, and unified handler log formatting so developers can trace message fragments back to full OneBot raw structures.

**Architecture:** A standalone CLI script (`scripts/inspect-msg.ts`) queries OneBot `get_msg` over WebSocket using `BotConfig` and pretty-prints message metadata. Core feature handlers (`EchoBot`, `LinkPreview`, `Sauce`) log incoming triggers with unified `[msg:<id>] [user:<id>]` identifiers and truncated snippets. `docs/troubleshooting.md` documents the step-by-step workflow connecting SnowLuma container logs, Sakurako logs, and `inspect-msg`.

**Tech Stack:** TypeScript 7, Bun (`bun:test`), Effect 4 (`effect`, `@effect/platform-bun`), `@snowluma/sdk`.

**Spec:** `.superpowers/specs/2026-10-30-observability-message-inspect-design.md`

## Global Constraints

- Do not use `any` or `as any`; adhere to `verbatimModuleSyntax: true` and project type rules.
- Local relative imports MUST include `.ts` extensions.
- Configuration MUST be read via `BotConfig` (`src/Config.ts`), never hardcoded.
- Text truncation for snippets MUST reuse `TextWidth.truncate` (`src/utils/TextWidth.ts`).
- Commit messages MUST follow Linux Kernel style (`scope: short summary`, `### Problem`, `### Solution`, `### References`).

## Review Focus

1. **Negative message IDs**: OneBot / SnowLuma message IDs can be negative 32-bit signed integers (e.g. `-12345678`); `parseMessageId` must accept negative integers. (Pinned in Task 1)
2. **Invalid or missing CLI arguments**: `inspect-msg` called without arguments or with non-integer strings (`abc`, `12.34`) must fail gracefully with usage instructions and exit code 1. (Pinned in Task 1)
3. **OneBot API error response**: When `get_msg` returns non-zero retcode or connection drops, `inspect-msg` must output a readable error message without unhandled crashes. (Pinned in Task 1)
4. **Multiline text in log snippet**: Message text containing newlines or tabs must have whitespace collapsed into single spaces before logging so log lines remain single-line. (Pinned in Task 2)
5. **Missing or non-string message content**: If `raw_message` is undefined or array-only in `OneBotMessageEvent`, snippet generation must safely fall back without throwing. (Pinned in Task 2)

---

### Task 1: Message Inspection Script and CLI

**Files:**
- Create: `scripts/inspect-msg.ts`
- Create: `test/scripts/InspectMsg.test.ts`
- Modify: `package.json:27-28`

**Interfaces:**
- Consumes: `BotConfig` from `src/Config.ts`, `createWebSocketClient` from `@snowluma/sdk`
- Produces: `parseMessageId(args: readonly string[]): number | undefined`, `formatMessageSnippet(raw: string, maxWidth?: number): string`, CLI entrypoint `bun run inspect-msg <message_id>`

- [ ] **Step 1: Write failing unit tests for argument parsing and message formatting**

Create `test/scripts/InspectMsg.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { formatMessageReport, parseMessageId } from "../../scripts/inspect-msg.ts";

describe("InspectMsg CLI helper", () => {
  it("parses positive and negative integer message IDs", () => {
    expect(parseMessageId(["12345"])).toBe(12345);
    expect(parseMessageId(["-12345678"])).toBe(-12345678);
    expect(parseMessageId(["0"])).toBe(0);
  });

  it("returns undefined for missing or invalid argument", () => {
    expect(parseMessageId([])).toBeUndefined();
    expect(parseMessageId(["abc"])).toBeUndefined();
    expect(parseMessageId(["12.34"])).toBeUndefined();
    expect(parseMessageId(["--help"])).toBeUndefined();
  });

  it("formats message report with metadata and content", () => {
    const rawData = {
      message_id: 12345678,
      message_type: "group",
      group_id: 20002,
      group_name: "Mock Group",
      user_id: 10001,
      sender: {
        nickname: "Mock User",
        card: "Admin",
      },
      time: 1700000000,
      raw_message: "这是一条测试消息",
      message: [{ type: "text", data: { text: "这是一条测试消息" } }],
    };
    const report = formatMessageReport(rawData);
    expect(report).toContain("Message ID: 12345678");
    expect(report).toContain("Group: Mock Group (20002)");
    expect(report).toContain("Sender: Admin (10001)");
    expect(report).toContain("这是一条测试消息");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/InspectMsg.test.ts`
Expected: FAIL with module not found or export missing.

- [ ] **Step 3: Implement `scripts/inspect-msg.ts` and add script to `package.json`**

Implement `scripts/inspect-msg.ts` exporting `parseMessageId`, `formatMessageReport`, and executing the Effect workflow when run as main (`import.meta.main`):
- `parseMessageId(args: readonly string[]): number | undefined`: validates `/^-?\d+$/`.
- `formatMessageReport(data: any): string`: formats key metadata fields (ID, Type, Group, Sender, Time, Raw Message, Segments JSON).
- Main program:
  - If `parseMessageId(process.argv.slice(2))` is undefined, log usage: `Usage: bun run inspect-msg <message_id>` and `process.exit(1)`.
  - Load `BotConfig`.
  - Connect WebSocket via `createWebSocketClient({ url: config.wsUrl, accessToken: Redacted.value(config.accessToken) })`.
  - Request `get_msg` with `message_id`.
  - If `retcode !== 0` or error, log error and exit(1).
  - Print report and full JSON indented.
  - Close socket cleanly.
In `package.json`:
Add `"inspect-msg": "bun scripts/inspect-msg.ts"` under `"scripts"`.

- [ ] **Step 4: Run test and verify it passes**

Run: `bun test test/scripts/InspectMsg.test.ts`
Expected: PASS.

- [ ] **Step 5: Smoke test with actual SnowLuma connection**

Run: `bun run inspect-msg 12345678`
Expected: Prints formatted message details and JSON for message `12345678`.

- [ ] **Step 6: Commit**

```bash
git add scripts/inspect-msg.ts test/scripts/InspectMsg.test.ts package.json
git commit -m "feat(scripts): add inspect-msg script for raw message debugging

### Problem

Inspecting raw OneBot message structures and sender metadata currently
requires manual WebSocket or API requests with authentication tokens.

### Solution

Add scripts/inspect-msg.ts and register npm script 'inspect-msg'.
The tool loads BotConfig, queries get_msg via SnowLuma WebSocket, and
pretty-prints message metadata and raw payload.

### References

Observability design (.superpowers/specs/2026-10-30-observability-message-inspect-design.md)"
```

---

### Task 2: Standardize Handler Log Format

**Files:**
- Create: `src/utils/LogFormat.ts`
- Create: `test/utils/LogFormat.test.ts`
- Modify: `src/features/echo/EchoBot.ts:13-18`
- Modify: `src/features/link-preview/LinkPreview.ts:504-510`
- Modify: `src/features/sauce/Sauce.ts:71-76`

**Interfaces:**
- Consumes: `TextWidth.truncate` from `src/utils/TextWidth.ts`, `OneBotMessageEvent` from `@snowluma/sdk/types`
- Produces: `formatLogMessagePrefix(event: OneBotMessageEvent): string`, `formatLogSnippet(text: string | undefined, maxWidth?: number): string`

- [ ] **Step 1: Write failing tests for LogFormat utility**

Create `test/utils/LogFormat.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { formatLogMessagePrefix, formatLogSnippet } from "../../src/utils/LogFormat.ts";

describe("LogFormat", () => {
  it("formats message prefix with message_id and user_id", () => {
    const mockEvent = {
      message_id: 123456,
      user_id: 10001,
      message_type: "group",
      group_id: 20002,
    } as unknown as OneBotMessageEvent;

    expect(formatLogMessagePrefix(mockEvent)).toBe("[msg:123456] [user:10001]");
  });

  it("formats log snippet by collapsing newlines and truncating width", () => {
    expect(formatLogSnippet("hello\nworld\r\nfoo", 20)).toBe("hello world foo");
    expect(formatLogSnippet("这是一段非常非常长的测试文本用于验证日志截断效果", 10)).toBe("这是一段...");
    expect(formatLogSnippet(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/utils/LogFormat.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/utils/LogFormat.ts`**

Implement:
```ts
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { truncate } from "./TextWidth.ts";

export function formatLogMessagePrefix(event: OneBotMessageEvent): string {
  return `[msg:${event.message_id}] [user:${event.user_id}]`;
}

export function formatLogSnippet(text: string | undefined, maxWidth = 30): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncate(collapsed, maxWidth);
}
```

- [ ] **Step 4: Update handler log statements**

In `src/features/echo/EchoBot.ts`:
```ts
const prefix = formatLogMessagePrefix(event);
yield* Effect.logInfo(
  `${prefix} Received '喵喵喵' (${event.message_type}), replying...`,
);
```
In `src/features/link-preview/LinkPreview.ts`:
```ts
const prefix = formatLogMessagePrefix(event);
const snippet = formatLogSnippet(event.raw_message);
yield* Effect.logInfo(
  `${prefix} Found ${urls.length} URL(s) in message "${snippet}", scraping preview...`,
);
```
In `src/features/sauce/Sauce.ts`:
```ts
const prefix = formatLogMessagePrefix(event);
yield* Effect.logInfo(
  `${prefix} Received '/sauce', retrieving quoted message ${messageId}...`,
);
```

- [ ] **Step 5: Run tests and type checks**

Run: `bun test && bun run check && bun run lint`
Expected: All tests pass, typecheck and lint pass without warnings.

- [ ] **Step 6: Commit**

```bash
git add src/utils/LogFormat.ts test/utils/LogFormat.test.ts src/features/echo/EchoBot.ts src/features/link-preview/LinkPreview.ts src/features/sauce/Sauce.ts
git commit -m "feat(logging): standardize handler message prefixes and snippet logging

### Problem

Handler logs were missing message ID identifiers and message snippets,
making it difficult to correlate Sakurako execution logs with SnowLuma
event logs or retrieve raw OneBot messages.

### Solution

Introduce LogFormat helper and update EchoBot, LinkPreview, and Sauce
handlers to log [msg:<id>] [user:<id>] prefixes and truncated snippets.

### References

Observability design (.superpowers/specs/2026-10-30-observability-message-inspect-design.md)"
```

---

### Task 3: Troubleshooting Documentation

**Files:**
- Create: `docs/troubleshooting.md`

**Interfaces:**
- Consumes: `docker logs snowluma`, `bun run inspect-msg <id>`, Sakurako log format
- Produces: Developer troubleshooting guide

- [ ] **Step 1: Write `docs/troubleshooting.md`**

Document:
1. **Overview**: Explain the logging architecture (SnowLuma full events vs. Sakurako handler traces).
2. **Workflow: 从片段定位原始消息 (Fragment to Raw Metadata)**:
   - Step 1: Use `docker logs snowluma | grep "<片段>"` to find the event line and extract `ID:<message_id>`.
   - Step 2: Run `bun run inspect-msg <message_id>` to view formatted details and full OneBot payload.
3. **Correlating Sakurako Logs**:
   - Explain how `[msg:<message_id>]` in Sakurako logs maps to the OneBot event.
   - Show concrete examples for LinkPreview, Sauce, and EchoBot.
4. **Common Troubleshooting Scenarios**:
   - Link preview not triggered (URL extraction or Jev filter).
   - Sauce command failing to find image or quote.

- [ ] **Step 2: Verify formatting and linter**

Run: `bun run format && bun run lint && bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/troubleshooting.md
git commit -m "docs: add message debugging and troubleshooting guide

### Problem

Developers had no documented process for locating raw OneBot messages
and metadata when debugging issues starting from partial text fragments.

### Solution

Add docs/troubleshooting.md covering SnowLuma container log inspection,
the 'bun run inspect-msg' utility, and log correlation techniques.

### References

Observability design (.superpowers/specs/2026-10-30-observability-message-inspect-design.md)"
```
