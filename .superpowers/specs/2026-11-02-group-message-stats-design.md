# Group Message Statistics Feature Design

- **Date**: 2026-11-02
- **Topic**: Silent group message activity tracking and on-demand queries (`/stat`, `/me`)
- **Status**: Proposed

---

## 1. Intent and Why

Sakurako is an active QQ bot deployed in community group chats. Community members value understanding group dynamics, identifying active contributors, and viewing their own engagement trends. However, preserving member privacy and preventing data leakage are paramount.

This feature introduces a privacy-preserving message statistics service:
- **Silent tracking**: Collects quantitative metrics (total messages, media count, link count, interactions) per group member without saving any message body text or media content.
- **On-demand queries**:
  - `/stat` renders a high-density, visually appealing PNG leaderboard image (Option B) using Satori and Sharp with the MiSans typeface.
  - `/stat all` renders the all-time group leaderboard image.
  - `/me` replies with a concise plain-text quote breakdown of personal 30-day and all-time activity, along with group rankings.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Track all group messages and notice events (poke, reaction additions) into per-member daily buckets.
- Update member nickname/card mappings automatically from incoming group messages.
- Support both "last 30 days" and "all-time cumulative" queries via SQLite aggregate queries.
- Render group leaderboards (`/stat`, `/stat all`) as crisp PNG images using Satori and Sharp, formatted as a compact high-density data grid (Option B).
- Provide `/me` personal statistics via plain-text quote reply (`context.quote`).
- Integrate non-intrusively into Sakurako's Effect 4 architecture via dual streams in `SnowLumaClient`.

### Non-Goals
- Private message tracking (strictly scoped to group chats).
- File upload tracking (OneBot `group_upload` notices are ignored as specified).
- Content storage, search, NLP, or sentiment analysis.
- Cross-group aggregated leaderboards (statistics are isolated per `group_id`).

### Anti-Goals
- Never store message content, URLs, image hashes, or raw payload text in the database.
- Never let statistics recording or query errors crash the main message stream.
- Never use headless browsers (Puppeteer, Playwright) for rendering cards; Satori + Sharp ensures lightweight, deterministic SVG-to-PNG generation.

---

## 3. Constraints

- **Runtime**: Bun 1.4.4.
- **Framework**: Effect 4 (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`).
- **Dependencies**:
  - `satori` and `sharp` for image generation.
  - `@effect/sql-sqlite-bun` for SQLite database interactions.
  - MiSans font asset loaded into Satori for standard CJK typography.
- **Loop Prevention**: Must use `isSelfMessage(event)` from `src/utils/MessageGuard.ts` to ignore the bot's own events.
- **TypeScript & Linting**: `verbatimModuleSyntax: true`, no `any`, branded `Schema.TaggedError`, oxlint with `@effect/tsgo`.

---

## 4. Approaches Considered

### Approach 1: Dual Streams (`messages` + `notices`) with Non-Intrusive Integration (Chosen)
- `SnowLumaClient` continues to expose `messages: Stream.Stream<IncomingMessage>`.
- `SnowLumaClient` additionally exposes `notices: Stream.Stream<IncomingNotice>` (bridging `ws.onNotice`).
- Existing handlers (`EchoBot`, `LinkPreview`, `Sauce`) remain untouched with zero regression risk.
- The new `StatsService` subscribes to `messages` (for message tracking, profile updates, and command queries) and `notices` (for poke and reaction tracking).
- **Pros**: 100% backward compatibility, clean domain separation, robust error isolation per stream.
- **Cons**: Adds a second queue/stream to `SnowLumaClient`.

### Approach 2: Unified Event Stream (`events: Stream.Stream<IncomingEvent>`)
- Refactor `SnowLumaClient` to expose a single stream of all incoming OneBot events.
- Dispatch at top-level using type guards.
- **Pros**: Single conceptual event channel.
- **Cons**: Requires touching all existing handlers, changing `IncomingMessage` contracts, and refactoring unit test fixtures across existing features.

---

## 5. Detailed Specifications

### 5.1 Event Ingestion and Classification

Only events where `event.message_type === "group"` or `event.group_id !== undefined` are processed. Self-messages (`isSelfMessage(event)`) are ignored.

1. **Group Messages (`OneBotGroupMessageEvent`)**:
   - `total_count += 1`
   - **Media (`media_count += 1`)**:
     - Message segments contain any of: `image`, `record` (voice), `video`, or custom face/sticker segments.
     - Text + image mixed messages count towards `media_count`.
     - File uploads (`group_upload`) are explicitly not counted.
   - **Link (`link_count += 1`)**:
     - Message text contains HTTP/HTTPS URLs (evaluated using existing URL regex or `get-urls`).
   - **Member Profile**:
     - Upsert `member_profiles` with `user_id`, `group_id`, `nickname = event.sender.card || event.sender.nickname`, `updated_at = Date.now()`.

2. **Group Notices (`OneBotNoticeEvent`)**:
   - **Poke**:
     - `notice_type === "notify"` and `sub_type === "poke"`.
     - The operator (`user_id` / `sender_id`) receives `interaction_count += 1`.
   - **Reaction (Emoji Like)**:
     - `notice_type === "group_msg_emoji_like"` and `sub_type === "add"`.
     - The operator (`user_id` / `operator_id`) receives `interaction_count += 1`.
     - Emoji removals (`sub_type === "remove"`) do not decrement or affect counts.

3. **Date Bucketing**:
   - Bucket date string `YYYY-MM-DD` is computed using timezone `Asia/Shanghai` (UTC+8).

---

### 5.2 Database Schema (SQLite)

Database file stored at `./data/stats.db` (configurable via `BotConfig` if desired, defaulting to `./data/stats.db`).

```sql
CREATE TABLE IF NOT EXISTS member_daily_stats (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL, -- 'YYYY-MM-DD'
  total_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  link_count INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_member_daily_stats_group_date
  ON member_daily_stats(group_id, date);

CREATE TABLE IF NOT EXISTS member_profiles (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
```

#### Aggregate Queries
- **Last 30 Days**:
  ```sql
  SELECT
    s.user_id,
    COALESCE(p.nickname, CAST(s.user_id AS TEXT)) AS nickname,
    SUM(s.total_count) AS total_count,
    SUM(s.media_count) AS media_count,
    SUM(s.link_count) AS link_count,
    SUM(s.interaction_count) AS interaction_count
  FROM member_daily_stats s
  LEFT JOIN member_profiles p ON s.group_id = p.group_id AND s.user_id = p.user_id
  WHERE s.group_id = :group_id AND s.date >= :startDate
  GROUP BY s.user_id
  ORDER BY total_count DESC
  LIMIT 15;
  ```
- **All-Time**: Same query without `AND s.date >= :startDate`.

---

### 5.3 Query Commands & Responses

Commands are strictly matched on group messages (`post_type === "message"`, `message_type === "group"`).

#### 1. Leaderboard (`/stat` and `/stat all`)
- **Trigger**:
  - `/stat` (trimmed) -> queries last 30 days (`startDate = today - 29 days`).
  - `/stat all` (trimmed) -> queries all-time history.
- **Empty State**: If no messages recorded for the group in the period, reply text `"本群暂无统计数据。"` via `context.quote`.
- **Image Generation Pipeline**:
  1. Fetch Top 15 members and overall group message totals.
  2. Build JSX / virtual DOM structure representing Option B (Dense Multi-Column Grid).
  3. Load `MiSans-Medium` / `MiSans-Regular` font buffer (cached in memory).
  4. Call `satori(element, { width: 680, fonts: [...] })` -> SVG string.
  5. Call `sharp(Buffer.from(svg)).png().toBuffer()` -> PNG Buffer.
  6. Call `context.quote([image(pngBuffer)])`.
- **Anti-Spam / Cooldown**:
  - Group-level 5-second cooldown for `/stat` to prevent CPU exhaustion. Subsequent triggers during cooldown are silently ignored.

#### 2. Personal Statistics (`/me`)
- **Trigger**: `/me` (trimmed).
- **Data Extracted**:
  - User's last 30 days totals (and group rank by `total_count`).
  - User's all-time totals (and group rank by `total_count`).
- **Response Format**:
  ```text
  [回复 [User]]:
  📊 个人群聊统计 (近 30 天 / 历史累计)
  - 消息总计：1,623 / 5,420 条 (排名第 3 / 2)
  - 媒体消息：420 / 1,280 条
  - 包含链接：189 / 450 条
  - 互动次数：280 / 890 次
  ```
- If the user has 0 messages, show 0 counts and `-` for rank.

---

## 6. What's Left to the Builder

- Implementing the Satori component styling conforming to Option B (exact dark-mode hex colors `#18191c`, `#21262d`, accent borders, rank 1/2/3 colors `#f1e05a`, `#c0c0c0`, `#cd7f32`).
- Setting up the font asset download/storage in `assets/fonts/MiSans-Regular.ttf` or `assets/fonts/MiSans-Medium.ttf`.
- Unit tests covering event classification (media, links, interactions, notice events), database upserts, aggregate queries, and command parsers using mock HTTP/SDK contexts.
