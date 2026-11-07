# OpenRouter Decisions Generalization & Jev Neutralization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将链接预览过滤从特定于 Jev 的实现通用化为标准 OpenRouter Decisions 模型实现：更新 endpoint 为 `/api/alpha/decisions`，支持通过环境变量 `OPENROUTER_MODEL` 配置决策模型，并将代码库中所有面向 Jev 的命名和文档替换为中立的决策模型命名。

**Architecture:**
- 配置层（`src/Config.ts`）：新增 `OPENROUTER_MODEL` 配置项，读取为 `openrouterModel: string`，默认回退为 `DEFAULT_DECISION_MODEL = "~typesafe/jev-latest"`。
- 特性层（`src/features/link-preview/`）：将 `JevFilter.ts` 重命名为 `DecisionFilter.ts`，错误类重命名为 `DecisionFilterError`，更新常量 `OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"`，并将 `model` 参数传入 `filterPreviewResults`。
- 调用层（`src/features/link-preview/LinkPreview.ts`）：从 `BotConfig` 中读取 `openrouterApiKey` 与 `openrouterModel` 并传给 `filterPreviewResults`。
- 文档与测试（`docs/`、`test/`、`AGENTS.md`、`.env.example`）：清理所有 "Jev" 专有命名，统一采用中立的 "决策模型 / Decision Model"。

**Tech Stack:** TypeScript, Bun, Effect 4 (`effect`, `effect/http`), OpenRouter Decisions API.

**Spec:** User instructions in conversation.

## Global Constraints

- 遵循 Effect 4 与本项目的错误类规范（使用带有 `{ readonly brand: unique symbol }` 的 `Schema.TaggedError`）。
- 不引入任何外部 AI SDK，保持现有的原生 `effect/http` + `fetchJson` 架构。
- 保证无配置 `OPENROUTER_API_KEY` 或 API 异常时的 Fail-Open 弹性回退。
- 所有本地导入必须包含 `.ts` 扩展名，严格遵循 `verbatimModuleSyntax`。
- 保持 `bun test`、`bun run check`、`bun run lint`、`bun run knip` 全绿。

## Review Focus

1. **环境变量缺省兼容性**：当未配置 `OPENROUTER_MODEL` 时，系统无缝回退到 `~typesafe/jev-latest`，现有行为不发生任何变化。
2. **自定义模型传入**：配置 `OPENROUTER_MODEL=openai/gpt-6-luna-decisions` 或其他模型时，请求 payload 中的 `model` 字段精确匹配配置值。
3. **Endpoint 更新对齐**：请求发往 `https://openrouter.ai/api/alpha/decisions`，现有针对请求头、鉴权以及 `state`/`questions` 结构的校验依然正确。
4. **全库重命名完整性**：清理所有符号与文件中的 `Jev`（包括 `JevFilter`、`JevFilterError`、`DEFAULT_JEV_MODEL` 等），避免残留或遗漏导致 knip 或编译报错。
5. **Fail-Open 稳健性**：当 `/api/alpha/decisions` 返回 429、500、网络超时或畸变数据时，日志输出中立的 warning 并正确回退至未过滤的预览。

---

### Task 1: 在 `BotConfig` 中增加 `openrouterModel` 支持

**Files:**
- Modify: `src/Config.ts`
- Modify: `.env.example`
- Test: `test/Config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BotConfig {
    readonly wsUrl: string;
    readonly accessToken: Redacted.Redacted<string>;
    readonly sauceNaoApiKey?: Redacted.Redacted<string>;
    readonly openrouterApiKey?: Redacted.Redacted<string>;
    readonly openrouterModel: string;
    readonly devMode: boolean;
    readonly devGroupId?: number;
  }
  ```

- [ ] **Step 1: Write the failing tests in `test/Config.test.ts`**

在 `test/Config.test.ts` 中补充针对 `openrouterModel` 的测试：
1. 当未提供 `OPENROUTER_MODEL` 时，`result.openrouterModel` 默认为 `~typesafe/jev-latest`。
2. 当提供 `OPENROUTER_MODEL: "openai/gpt-6-luna-decisions"` 时，`result.openrouterModel` 为 `"openai/gpt-6-luna-decisions"`。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/Config.test.ts`
Expected: FAIL with `property 'openrouterModel' does not exist on type 'BotConfig'`.

- [ ] **Step 3: Implement `openrouterModel` in `src/Config.ts` and update `.env.example`**

在 `src/Config.ts` 中：
```ts
export const DEFAULT_DECISION_MODEL = "~typesafe/jev-latest";
```
并在 `BotConfig` 中增加：
```ts
openrouterModel: Config.string("OPENROUTER_MODEL").pipe(
  Config.withDefault(DEFAULT_DECISION_MODEL),
),
```
更新 `.env.example` 中的注释说明与变量模板：
```env
# OpenRouter API Key (Optional, enables decision filtering for link previews)
# OPENROUTER_API_KEY=your_openrouter_api_key_here
# OpenRouter Decision Model (Optional, defaults to ~typesafe/jev-latest)
# OPENROUTER_MODEL=~typesafe/jev-latest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/Config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/Config.ts test/Config.test.ts .env.example
git commit -m "config: add optional OPENROUTER_MODEL configuration"
```

---

### Task 2: 重构与重命名 `JevFilter.ts` 为 `DecisionFilter.ts`

**Files:**
- Create/Move: `src/features/link-preview/DecisionFilter.ts` (from `src/features/link-preview/JevFilter.ts`)
- Create/Move: `test/features/link-preview/DecisionFilter.test.ts` (from `test/features/link-preview/JevFilter.test.ts`)
- Delete: `src/features/link-preview/JevFilter.ts`
- Delete: `test/features/link-preview/JevFilter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
  export { DEFAULT_DECISION_MODEL } from "../../Config.ts"; // or re-export

  export class DecisionFilterError extends Schema.TaggedError<
    DecisionFilterError,
    {
      readonly brand: unique symbol;
    }
  >()("DecisionFilterError", {
    cause: Schema.Defect(),
  }) {
    override get message(): string {
      return `DecisionFilterError: ${String(this.cause)}`;
    }
  }

  export const filterPreviewResults: (
    rawMessage: string,
    results: ReadonlyArray<ScrapingResult>,
    apiKey?: Redacted.Redacted<string>,
    model?: string,
    threshold?: number,
    timeoutDuration?: Duration.Input,
  ) => Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient>;
  ```

- [ ] **Step 1: Write the updated tests in `test/features/link-preview/DecisionFilter.test.ts`**

重命名并调整测试用例：
1. 将所有 `JevFilter`、`OPENROUTER_SYSTEMONE_URL`、`DEFAULT_JEV_MODEL` 导入替换为 `DecisionFilter`、`OPENROUTER_DECISIONS_URL`、`DEFAULT_DECISION_MODEL`。
2. 校验请求发送目标 URL 为 `https://openrouter.ai/api/alpha/decisions`。
3. 增加测试用例：当调用 `filterPreviewResults` 传入显式 `model: "custom/model-id"` 时，验证请求体中的 `payload.model` 为 `"custom/model-id"`。
4. 验证默认 `model` 为 `DEFAULT_DECISION_MODEL`。
5. 更新日志与错误提示的断言内容（"Decision filter failed..." 代替 "Jev decision filter failed..."）。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: FAIL because `DecisionFilter.ts` does not exist yet.

- [ ] **Step 3: Implement `src/features/link-preview/DecisionFilter.ts`**

1. 将 `OPENROUTER_SYSTEMONE_URL` 更新并重命名为：
   ```ts
   export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
   ```
2. 导出 `DEFAULT_DECISION_MODEL = "~typesafe/jev-latest"`。
3. 重命名错误类为 `DecisionFilterError`，更新 brand 和 tag。
4. 更新函数签名：
   ```ts
   export const filterPreviewResults = Effect.fn(
     "DecisionFilter.filterPreviewResults",
   )(
     function* (
       rawMessage: string,
       results: ReadonlyArray<ScrapingResult>,
       apiKey?: Redacted.Redacted<string>,
       model: string = DEFAULT_DECISION_MODEL,
       threshold: number = DEFAULT_THRESHOLD,
       timeoutDuration: Duration.Input = DEFAULT_TIMEOUT,
     ) { ... }
   )
   ```
5. Payload 中使用传入的 `model` 参数。
6. 日志调整为 `Decision filter failed, falling back to original preview: ${String(error)}`。
7. 删除旧的 `src/features/link-preview/JevFilter.ts`。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: PASS (12+ tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/DecisionFilter.ts test/features/link-preview/DecisionFilter.test.ts
git rm src/features/link-preview/JevFilter.ts test/features/link-preview/JevFilter.test.ts
git commit -m "link-preview: generalize JevFilter into DecisionFilter with alpha decisions endpoint"
```

---

### Task 3: 更新 `LinkPreview.ts` 与集成测试 `LinkPreviewBot.test.ts`

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Modify: `test/features/link-preview/LinkPreviewBot.test.ts`

**Interfaces:**
- Consumes: `filterPreviewResults`, `DEFAULT_DECISION_MODEL` from `DecisionFilter.ts`.

- [ ] **Step 1: Update `src/features/link-preview/LinkPreview.ts`**

1. 导入源从 `./JevFilter.ts` 改为 `./DecisionFilter.ts`：
   ```ts
   import { DEFAULT_DECISION_MODEL, filterPreviewResults } from "./DecisionFilter.ts";
   ```
2. 在 `handleLinkPreviewMessage` 中读取并传递 `openrouterModel`：
   ```ts
   const openrouterApiKey = Option.getOrUndefined(config)?.openrouterApiKey;
   const openrouterModel = Option.getOrUndefined(config)?.openrouterModel ?? DEFAULT_DECISION_MODEL;
   const filteredResults = yield* filterPreviewResults(
     event.raw_message,
     results,
     openrouterApiKey,
     openrouterModel,
   );
   ```

- [ ] **Step 2: Update `test/features/link-preview/LinkPreviewBot.test.ts`**

1. 更新测试名称中的 "Jev" 为中立描述：
   - "silences reply when single link preview is filtered by decision model"
   - "outputs placeholder when one of multiple links is filtered by decision model"
2. 确认测试中的 mock 请求匹配（`req.url.includes("openrouter.ai")`）正常工作。

- [ ] **Step 3: Run link preview tests to verify they pass**

Run: `bun test test/features/link-preview/LinkPreviewBot.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewBot.test.ts
git commit -m "link-preview: wire openrouterModel to filterPreviewResults"
```

---

### Task 4: 更新文档与指南中的 "Jev" 字样

**Files:**
- Modify: `docs/features/link-preview.md`
- Modify: `docs/troubleshooting.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update documentation files**

1. `docs/features/link-preview.md`:
   - 将“使用 Jev 决策模型评估链接预览...”修改为“使用 OpenRouter 决策模型（默认 `~typesafe/jev-latest`，可通过 `OPENROUTER_MODEL` 自定义）评估链接预览...”。
2. `docs/troubleshooting.md`:
   - 将“4. **Jev 决策模型过滤**”修改为“4. **决策模型过滤**”。
3. `AGENTS.md`:
   - 将“4. **Jev 决策模型过滤**”修改为“4. **决策模型过滤**”。
   - 更新“Important Files”中的条目说明：将 `JevFilter.ts` 替换为 `DecisionFilter.ts`。

- [ ] **Step 2: Commit**

```bash
git add docs/features/link-preview.md docs/troubleshooting.md AGENTS.md
git commit -m "docs: replace Jev with neutral decision model terminology"
```

---

### Task 5: 全库格式化、静态检查与回归测试

**Files:**
- Repository-wide verification

- [ ] **Step 1: Run complete test suite**

Run: `bun test`
Expected: All tests pass without errors.

- [ ] **Step 2: Run type check, linter and knip**

Run: `bun run check && bun run lint && bun run knip`
Expected: All checks pass clean with 0 warnings / errors.

- [ ] **Step 3: Run formatter**

Run: `bun run format`
Expected: Code formatted according to project conventions.

- [ ] **Step 4: Commit if formatted changes exist**

```bash
git add -A
git commit -m "chore: run format and final verification"
```
