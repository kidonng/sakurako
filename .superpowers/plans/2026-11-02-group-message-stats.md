# Group Message Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement silent QQ group message statistics tracking into SQLite daily buckets (total, media, link, interaction) and provide `/stat` (Option B image leaderboard via Satori + Sharp with MiSans) and `/me` (plain-text personal statistics) active queries.

**Architecture:** Dual-stream event pipeline where `SnowLumaClient` extends to stream both `messages` and `notices`. A pure `StatsClassifier` identifies media, link, and interaction events. `StatsRepository` leverages `@effect/sql-sqlite-bun` to upsert daily bucket counters and execute aggregate ranking queries. `StatsRenderer` renders Satori JSX to PNG using Sharp. `StatsCommand` handles `/stat`, `/stat all`, and `/me` with cooldown and fallback protections.

**Tech Stack:** Bun 1.4.4, Effect 4 (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`), `@snowluma/sdk`, `satori`, `sharp`, SQLite, MiSans font.

**Spec:** `.superpowers/specs/2026-11-02-group-message-stats-design.md`

## Global Constraints

- Runtime: Bun 1.4.4 exclusively.
- Framework: Effect 4 (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`).
- Module Resolution: `verbatimModuleSyntax: true`, `.ts` extensions required in local relative imports.
- TypeScript & Linting: No `any` or `as any` (use `unknown as T`), branded `Schema.TaggedError`, pass `bun run check` and `bun run lint`.
- Anti-Loop: All event consumers must filter out self-messages via `isSelfMessage(event)` from `src/utils/MessageGuard.ts`.
- Timezone: Daily buckets strictly use `Asia/Shanghai` (UTC+8) date strings (`YYYY-MM-DD`).
- Image Generation: Leaderboard uses Satori + Sharp with Option B (compact multi-column grid) and MiSans font.

## Review Focus

1. **Combined media + link message**: A single message containing both an image segment and a URL must increment `total_count` by 1, `media_count` by 1, and `link_count` by 1. (Pinned to Task 2 & Task 5).
2. **Reaction removal notice**: A notice with `notice_type === "group_msg_emoji_like"` and `sub_type === "remove"` must be ignored and not increment or decrement interaction count. (Pinned to Task 2 & Task 5).
3. **Personal stats query (`/me`) for user with 0 messages**: Returns 0 for all counts and `"-"` for rank without throwing SQL errors or division by zero. (Pinned to Task 3 & Task 7).
4. **Empty group leaderboard (`/stat`)**: If the group has 0 recorded messages, returns plain-text `"本群暂无统计数据。"` quote reply instead of rendering an empty image. (Pinned to Task 7).
5. **Cooldown on `/stat`**: Rapid repeated `/stat` queries in the same group within 5 seconds are silently ignored without generating images. (Pinned to Task 7).

---

### Task 1: Dependencies and Font Asset Setup

**Files:**
- Modify: `package.json`
- Create: `scripts/download-font.ts`
- Create: `assets/fonts/.gitkeep`

**Interfaces:**
- Consumes: None
- Produces: Installed `@effect/sql-sqlite-bun`, `satori`, `sharp`, `@types/sharp`, and downloaded MiSans font file at `assets/fonts/MiSans-Normal.ttf`.

- [ ] **Step 1: Install runtime and dev dependencies**

Run:
```bash
bun add @effect/sql-sqlite-bun@^4.1.1 satori@^0.12.1 sharp@^0.33.5
bun add -d @types/sharp@^0.31.1
```

- [ ] **Step 2: Create font download script `scripts/download-font.ts`**

Write `scripts/download-font.ts` to ensure `assets/fonts/MiSans-Normal.ttf` exists (downloading and unzipping `MiSans-Normal.ttf` from `https://hyperos.mi.com/font-download/MiSans.zip` if missing, or extracting directly).

- [ ] **Step 3: Run font download script and verify font file**

Run: `bun scripts/download-font.ts`
Expected: `assets/fonts/MiSans-Normal.ttf` exists and is a valid TTF file (> 1MB).

- [ ] **Step 4: Verify check & lint**

Run: `bun run check && bun run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock scripts/download-font.ts assets/
git commit -m "build: add @effect/sql-sqlite-bun, satori, sharp and font setup

### Problem

Message statistics and image rendering require SQLite bindings, SVG
generation (Satori), PNG rasterization (Sharp), and MiSans typography.

### Solution

Install @effect/sql-sqlite-bun, satori, and sharp dependencies and provide
a font setup script for MiSans.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 2: Message & Notice Event Classifier (`StatsClassifier`)

**Files:**
- Create: `src/features/stats/StatsClassifier.ts`
- Test: `test/features/stats/StatsClassifier.test.ts`

**Interfaces:**
- Consumes: `OneBotNoticeEvent`, `OneBotGroupMessageEvent` from `@snowluma/sdk/types`
- Produces:
  ```ts
  export interface MessageClassification {
    readonly hasMedia: boolean;
    readonly hasLink: boolean;
  }
  export function classifyMessage(message: unknown, rawMessage?: string): MessageClassification;
  export function isGroupPokeNotice(event: unknown): event is {
    readonly post_type: "notice";
    readonly notice_type: "notify";
    readonly sub_type: "poke";
    readonly group_id: number;
    readonly user_id: number;
  };
  export function isGroupReactionNotice(event: unknown): event is {
    readonly post_type: "notice";
    readonly notice_type: "group_msg_emoji_like";
    readonly sub_type: "add" | "remove";
    readonly group_id: number;
    readonly user_id: number;
  };
  export function getShanghaiDateString(date?: Date): string;
  ```

- [ ] **Step 1: Write failing tests in `test/features/stats/StatsClassifier.test.ts`**

Test cases:
- Detects image, record, video segments as `hasMedia: true`.
- Detects http/https URLs in text and raw_message as `hasLink: true`.
- Combined media + link: message with both image and URL returns `{ hasMedia: true, hasLink: true }` (Review Focus 1).
- Detects group poke notice: `post_type: "notice", notice_type: "notify", sub_type: "poke", group_id: 123, user_id: 456`.
- Detects reaction notice `group_msg_emoji_like` with `sub_type: "add"` vs `sub_type: "remove"` (Review Focus 2).
- Formats date string strictly in `Asia/Shanghai` (`YYYY-MM-DD`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsClassifier.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `StatsClassifier.ts`**

Implement `classifyMessage`, `isGroupPokeNotice`, `isGroupReactionNotice`, and `getShanghaiDateString`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/stats/StatsClassifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/stats/StatsClassifier.ts test/features/stats/StatsClassifier.test.ts
git commit -m "feat(stats): add event classifier and date helper

### Problem

Group events must be classified into media, link, and interaction
categories without persisting message text.

### Solution

Implement pure classification functions for OneBot messages and notice
events with Asia/Shanghai date bucketing.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 3: Database Service (`StatsRepository`)

**Files:**
- Create: `src/features/stats/StatsRepository.ts`
- Test: `test/features/stats/StatsRepository.test.ts`

**Interfaces:**
- Consumes: `@effect/sql-sqlite-bun`, `SqliteClient`
- Produces:
  ```ts
  export interface MemberStatsRow {
    readonly userId: number;
    readonly nickname: string;
    readonly totalCount: number;
    readonly mediaCount: number;
    readonly linkCount: number;
    readonly interactionCount: number;
  }
  export interface LeaderboardResult {
    readonly groupTotal: number;
    readonly rows: readonly MemberStatsRow[];
  }
  export interface UserPeriodStats {
    readonly totalCount: number;
    readonly mediaCount: number;
    readonly linkCount: number;
    readonly interactionCount: number;
    readonly rank: number | null;
  }
  export interface UserStatsResult {
    readonly userId: number;
    readonly nickname: string;
    readonly stats30d: UserPeriodStats;
    readonly statsAll: UserPeriodStats;
  }
  export class StatsRepository extends Context.Service<StatsRepository, {
    readonly initSchema: Effect.Effect<void>;
    readonly recordMessage: (groupId: number, userId: number, date: string, counts: { hasMedia: boolean; hasLink: boolean }) => Effect.Effect<void>;
    readonly recordInteraction: (groupId: number, userId: number, date: string) => Effect.Effect<void>;
    readonly upsertProfile: (groupId: number, userId: number, nickname: string) => Effect.Effect<void>;
    readonly getLeaderboard: (groupId: number, startDate?: string, limit?: number) => Effect.Effect<LeaderboardResult>;
    readonly getUserStats: (groupId: number, userId: number, startDate30d: string) => Effect.Effect<UserStatsResult>;
  }>()("sakurako/StatsRepository") {}
  ```

- [ ] **Step 1: Write failing tests in `test/features/stats/StatsRepository.test.ts`**

Test cases using in-memory SQLite (`SqliteClient.layer({ db: ":memory:" })`):
- Initializes `member_daily_stats` and `member_profiles` tables.
- Records message: inserts and increments `total_count`, `media_count`, `link_count`.
- Records interaction: inserts and increments `interaction_count`.
- Upserts member profile: stores latest nickname.
- Query leaderboard: aggregates sums correctly, sorts by `totalCount DESC`, joins nickname.
- Query user stats: computes 30-day and all-time totals and ranks.
- Review Focus 3: Query user stats for user with 0 messages returns 0 counts and `rank: null` without error.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsRepository.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StatsRepository.ts`**

Implement `StatsRepository` service and static `layer` using `SqliteClient.SqliteClient`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/stats/StatsRepository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/stats/StatsRepository.ts test/features/stats/StatsRepository.test.ts
git commit -m "feat(stats): add StatsRepository with SQLite daily buckets

### Problem

Member activity metrics must be stored in daily buckets and aggregated
for last-30-day and all-time leaderboards.

### Solution

Implement StatsRepository service using @effect/sql-sqlite-bun with
atomic upserts and aggregate queries.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 4: SnowLuma Client Notice Stream Extension

**Files:**
- Modify: `src/SnowLuma.ts`
- Test: `test/SnowLuma.test.ts`

**Interfaces:**
- Consumes: `@snowluma/sdk`
- Produces:
  ```ts
  export interface IncomingNotice {
    readonly event: OneBotNoticeEvent;
    readonly context: SnowLumaEventContextWithQuote<OneBotNoticeEvent>;
  }
  // Inside SnowLumaClient:
  readonly messages: Stream.Stream<IncomingMessage>;
  readonly notices: Stream.Stream<IncomingNotice>;
  ```

- [ ] **Step 1: Write failing test in `test/SnowLuma.test.ts`**

Test case:
- `SnowLumaClient` service exposes both `messages` and `notices` streams.
- Callback `ws.onNotice` feeds `notices` queue without disrupting `messages`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/SnowLuma.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/SnowLuma.ts`**

Add `noticeQueue = yield* Queue.unbounded<IncomingNotice>()`, register `ws.onNotice`, shutdown `noticeQueue` in finalizer, and expose `notices: Stream.fromQueue(noticeQueue)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/SnowLuma.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/SnowLuma.ts test/SnowLuma.test.ts
git commit -m "feat(snowluma): expose notices stream in SnowLumaClient

### Problem

Interaction events like poke and emoji reactions arrive as OneBot notice
events, but SnowLumaClient only streamed messages.

### Solution

Extend SnowLumaClient to expose a notices Stream while preserving the
existing messages Stream contract.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 5: Event Ingestion Collector (`StatsCollector`)

**Files:**
- Create: `src/features/stats/StatsCollector.ts`
- Test: `test/features/stats/StatsCollector.test.ts`

**Interfaces:**
- Consumes: `StatsRepository`, `StatsClassifier`, `IncomingMessage`, `IncomingNotice`, `isSelfMessage`
- Produces:
  ```ts
  export function handleStatsMessage(item: IncomingMessage): Effect.Effect<void, never, StatsRepository>;
  export function handleStatsNotice(item: IncomingNotice): Effect.Effect<void, never, StatsRepository>;
  ```

- [ ] **Step 1: Write failing tests in `test/features/stats/StatsCollector.test.ts`**

Test cases:
- Ignores self-messages (`isSelfMessage(event) === true`).
- Ignores private messages.
- Processes group message: updates profile nickname and calls `recordMessage`.
- Combined media + link: message with both image and link calls `recordMessage` with `{ hasMedia: true, hasLink: true }` (Review Focus 1).
- Processes group poke notice: calls `recordInteraction`.
- Processes group reaction addition (`sub_type === "add"`): calls `recordInteraction`.
- Review Focus 2: Ignores reaction removal (`sub_type === "remove"`) without calling `recordInteraction`.
- Error isolation: database failures are caught and logged without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsCollector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StatsCollector.ts`**

Implement `handleStatsMessage` and `handleStatsNotice` with `Effect.catchAll` error boundaries.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/stats/StatsCollector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/stats/StatsCollector.ts test/features/stats/StatsCollector.test.ts
git commit -m "feat(stats): add StatsCollector for silent event ingestion

### Problem

Incoming group messages and interaction notices must be silently recorded
with error isolation and anti-loop guards.

### Solution

Implement handleStatsMessage and handleStatsNotice consumers using
StatsClassifier and StatsRepository.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 6: Leaderboard Image Renderer (`StatsRenderer`)

**Files:**
- Create: `src/features/stats/StatsRenderer.ts`
- Test: `test/features/stats/StatsRenderer.test.ts`

**Interfaces:**
- Consumes: `satori`, `sharp`, `LeaderboardResult`
- Produces:
  ```ts
  export interface RenderLeaderboardOptions {
    readonly groupName?: string;
    readonly timeLabel: string; // e.g. "最近 30 天" or "历史累计"
    readonly data: LeaderboardResult;
  }
  export class StatsRenderer extends Context.Service<StatsRenderer, {
    readonly renderLeaderboard: (options: RenderLeaderboardOptions) => Effect.Effect<Buffer>;
  }>()("sakurako/StatsRenderer") {
    static readonly layer: Layer.Layer<StatsRenderer>;
  }
  ```

- [ ] **Step 1: Write failing test in `test/features/stats/StatsRenderer.test.ts`**

Test case:
- Renders `LeaderboardResult` with mock font to PNG Buffer.
- Output buffer starts with PNG magic bytes `0x89, 0x50, 0x4E, 0x47`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsRenderer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StatsRenderer.ts`**

Implement Option B (Compact Multi-Column Data Table) JSX structure in Satori, loading `assets/fonts/MiSans-Normal.ttf`, and piping through `sharp().png().toBuffer()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/stats/StatsRenderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/stats/StatsRenderer.ts test/features/stats/StatsRenderer.test.ts
git commit -m "feat(stats): add StatsRenderer using Satori and Sharp

### Problem

The group leaderboard requires high-density image rendering with Option B
layout and MiSans CJK typography.

### Solution

Implement StatsRenderer service generating SVG with Satori and rasterizing
to PNG with Sharp.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 7: Query Commands Handler (`StatsCommand`)

**Files:**
- Create: `src/features/stats/StatsCommand.ts`
- Test: `test/features/stats/StatsCommand.test.ts`

**Interfaces:**
- Consumes: `StatsRepository`, `StatsRenderer`, `IncomingMessage`
- Produces:
  ```ts
  export function handleStatsCommand(
    item: IncomingMessage
  ): Effect.Effect<void, never, StatsRepository | StatsRenderer>;
  ```

- [ ] **Step 1: Write failing tests in `test/features/stats/StatsCommand.test.ts`**

Test cases:
- Non-group messages ignored.
- Message not matching `/stat`, `/stat all`, or `/me` ignored.
- `/stat` queries 30-day leaderboard, renders image, and calls `context.quote([image(buffer)])`.
- `/stat all` queries all-time leaderboard, renders image, and quotes back.
- Review Focus 4: Empty group calling `/stat` returns `"本群暂无统计数据。"` quote reply without rendering image.
- Review Focus 5: Rapid repeated `/stat` in same group within 5 seconds is throttled/ignored.
- `/me` formats user personal 30d and all-time stats and quotes text reply.
- Review Focus 3: `/me` for user with 0 messages replies with 0 counts and `"-"` rank.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsCommand.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `StatsCommand.ts`**

Implement command matching, cooldown state map, empty state branch, and quotes response.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/stats/StatsCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/stats/StatsCommand.ts test/features/stats/StatsCommand.test.ts
git commit -m "feat(stats): add StatsCommand for /stat and /me queries

### Problem

Users need active commands to query group leaderboards and personal
statistics with cooldown protection and empty-state fallbacks.

### Solution

Implement handleStatsCommand handling /stat, /stat all, and /me with
in-memory cooldown and formatted replies.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```

---

### Task 8: Integration and Wiring

**Files:**
- Modify: `src/index.ts`
- Test: `test/features/stats/StatsIntegration.test.ts`

**Interfaces:**
- Consumes: All stats services, `SnowLumaClient`, `SqliteClient`
- Produces: Integrated bot runtime listening to both `messages` and `notices`.

- [ ] **Step 1: Write end-to-end integration test in `test/features/stats/StatsIntegration.test.ts`**

Test scenario:
- Feed mock group message -> verify recorded in stats repository.
- Feed mock poke notice -> verify interaction count incremented.
- Feed `/me` message -> verify quote reply dispatched with stats text.
- Feed `/stat` message -> verify quote reply dispatched with image.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/stats/StatsIntegration.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/index.ts`**

Compose `SqliteClient.layer({ db: "data/stats.db" })`, `StatsRepository.layer`, and `StatsRenderer.layer`. Dispatch `messages` to `[handleIncomingMessage, handleLinkPreviewMessage, handleSauceMessage, handleStatsMessage, handleStatsCommand]` and `notices` to `[handleStatsNotice]`.

- [ ] **Step 4: Run all tests and validation checks**

Run:
```bash
bun test
bun run check
bun run lint
bun run knip
```
Expected: All tests pass, 0 type errors, 0 linter warnings.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/features/stats/StatsIntegration.test.ts
git commit -m "feat: integrate message statistics feature into main runtime

### Problem

Stats services must be wired into the live application entrypoint and
connected to SQLite persistence and dual event streams.

### Solution

Compose SqliteClient, StatsRepository, and StatsRenderer layers in
src/index.ts and dispatch incoming messages and notices concurrently.

### References

.superpowers/specs/2026-11-02-group-message-stats-design.md"
```
