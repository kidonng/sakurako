# Repository Guidelines

## Project Overview

Sakurako is a QQ bot built with TypeScript, running on Bun and powered by the Effect 4 framework (`effect`, `@effect/platform-bun`). It integrates with a SnowLuma OneBot v11 backend (running via OrbStack at `snowluma.orb.local`) via `@snowluma/sdk`.

Key features include:

- **Echo Bot**: Matches incoming messages strictly equaling `"喵喵喵"` and sends a plain text reply `"喵喵喵"`.
- **Link Preview**: Extracts HTTP/HTTPS links via `get-urls`, fetches OpenGraph/HTML metadata using `metascraper`, applies site-specific custom displays (e.g. GitHub, Hacker News), truncates text according to East Asian Width (`string-width`), guards against SSRF using `ip-address`, and sends structured direct replies (`context.reply`).
- **Image Sauce**: Matches incoming messages strictly equaling `"/sauce"` replying to an image, queries SauceNao API, and replies with work title, author, and source link.
- **Message Statistics**: Silently aggregates group member messages by type (total, media, links, interactions) into SQLite daily buckets using `@effect/sql-sqlite-bun` and `SqliteMigrator`. Generates Option B high-density leaderboard image cards via Satori + Sharp (`/stat`, `/stat all`) and replies with personal stats breakdowns (`/me`).
- **Danbooru**: Matches incoming messages starting with `"/dbr"`, processes tags using an offline bilingual SQLite dictionary (`assets/danbooru-tags.sqlite`), queries Danbooru random SFW posts, and replies with official format title and image.

## Architecture & Data Flow

The project follows a reactive, decoupled architecture built on Effect 4 services and streams:

```
[SnowLuma Backend] (ws://snowluma.orb.local:3001/)
       │
       ▼ (WebSocket events)
[SnowLumaClient] (src/SnowLuma.ts: Context.Service + Layer.effect)
  - Lifecycle: Effect.acquireRelease with exponential connection retry
  - Bridges events to an unbounded Queue via Queue.offerUnsafe
       │
       ▼ Stream.fromQueue
[Message & Notice Streams] (Stream.Stream<IncomingMessage> & Stream.Stream<IncomingNotice>)
       │
       ▼ Stream.runForEach (concurrent dispatch)
  ┌────┴───────────────┬───────────────────┬───────────────────┬───────────────────┬───────────────────┐
  ▼                    ▼                   ▼                   ▼                   ▼                   ▼
[EchoBot]          [LinkPreview]       [Sauce]             [Danbooru]          [Stats]             ...
(src/features/     (src/features/      (src/features/      (src/features/      (src/features/
 echo/EchoBot.ts)   link-preview/)      sauce/Sauce.ts)     danbooru/)          stats/)
  - "喵喵喵"           - metascraper       - /sauce            - /dbr [tags]       - /stat, /me
  - context.reply      - context.reply     - context.reply     - context.reply     - Satori + Sharp
       │                   │                   │                   │                   │
       └───────────────────┴───────────────────┴───────────────────┴───────────────────┴───────────────────┘
                                   ▼
[Entrypoint] (src/index.ts: BunRuntime.runMain)
```

- **Configuration Layer**: `src/Config.ts` reads `SNOWLUMA_WS_URL`, `SNOWLUMA_ACCESS_TOKEN`, and optional `SAUCENAO_API_KEY`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` using Effect's `Config` module.
- **Service Layer**: `SnowLumaClient` encapsulates `SnowLumaWebSocketClient`, managing socket connection, reconnection, and teardown inside a scoped `Layer`.
- **Event Pipeline**: WebSocket callbacks offer messages and notices to unbounded Queues, exposed downstream as typed `messages` and `notices` Streams.
- **Consumer Layer**: `src/index.ts` dispatches messages concurrently to `EchoBot`, `LinkPreview`, `Sauce`, `Danbooru`, `StatsCollector`, and `StatsCommand`, and notices to `StatsCollector`. Each handler isolates errors per event with `Effect.catch`, ensuring streams remain active even if individual reply actions fail.

## Key Directories

- `src/`: Core application source files (services, handlers, entrypoint, configuration).
- `test/`: Unit and integration test suites using `bun:test`.
- `.superpowers/specs/`: Architecture specifications and design documents.
- `.superpowers/plans/`: Implementation plans and task breakdowns.
- `docs/config.md`: Configuration, deployment, and static resource setup guide.
- `docs/features/`: User-facing feature documentation (e.g. `docs/features/link-preview.md`).

## Development Commands

All development tasks use Bun:

- **Run Bot**: `bun start` (or `bun src/index.ts`)
- **Run Tests**: `bun test` (single file: `bun test test/features/echo/EchoBot.test.ts`)
- **Type Check**: `bun run check` (runs `tsc`, validates types and `verbatimModuleSyntax`)
- **Lint**: `bun run lint` (runs `oxlint` with `oxlint-tsgolint` & `@effect/tsgo` rules)
- **Unused Code & Dependency Check**: `bun run knip` (runs `knip`)
- **Format**: `bun run format` (runs `bun fmt`)
- **Download Font**: `bun run download-font` (downloads MiSans font archive for stats rendering)
- **Download Danbooru Tags**: `bun run download-tags` (downloads Danbooru bilingual tags SQLite database)
- **Post-Install Setup**: `bun run prepare` (`effect-tsgo patch --typescript --oxlint`)

## Code Conventions & Common Patterns

### File & Code Naming

- **Files**: PascalCase for services and domain modules (`SnowLuma.ts`, `EchoBot.ts`, `Config.ts`), camelCase for entry points (`index.ts`).
- **Extensions**: Always include `.ts` extensions in local relative imports (e.g. `import { BotConfig } from "./Config.ts"`), required by `"allowImportingTsExtensions": true`.
- **Types vs Values**: Enforce `verbatimModuleSyntax: true` using `import type { ... }` or `import { type Foo, Bar } from "..."`.

### Effect 4 Patterns

General Effect patterns (`Effect.fn`, `Schema`, `Context.Service`, `Stream`, `DateTime`, etc.) follow `@node_modules/effect/AGENTS.md`. Note the repository-specific requirements:

- **Branded Schema Errors**: Due to `effecttsgo/schema-class-missing-brand`, always provide `{ readonly brand: unique symbol }` as the second type argument to `Schema.TaggedError`:
  ```ts
  export class WebSocketConnectionError extends Schema.TaggedError<
    WebSocketConnectionError,
    {
      readonly brand: unique symbol;
    }
  >()("WebSocketConnectionError", { message: Schema.String }) {}
  ```
- **Callback Ingestion**: In non-Effect callbacks (e.g. WebSocket listeners), offer items synchronously via `Queue.offerUnsafe` rather than creating fibers.

### Handler Guards

- **Loop prevention**: every handler starts by checking `isSelfMessage(event)` from `src/utils/MessageGuard.ts`. Never re-implement the `post_type === "message_sent" || user_id === self_id` comparison inline, and never treat an event with a missing `user_id` as self-sent.
- **Group message filter**: handlers operating strictly on group messages should use `isGroupMessage(event)` from `src/utils/MessageGuard.ts` to ensure `message_type === "group"` and valid `group_id` and `user_id`.

## Important Files

- `src/index.ts`: Application entry point dispatching messages concurrently to `handleIncomingMessage`, `handleLinkPreviewMessage`, and `handleSauceMessage` with merged `SnowLumaClient.layer` and `FetchHttpClient.layer` via `BunRuntime.runMain`.
- `src/Config.ts`: Effect `Config.all` schema for `SNOWLUMA_WS_URL`, `SNOWLUMA_ACCESS_TOKEN` (`Redacted`), optional `SAUCENAO_API_KEY` (`Redacted`), optional `OPENROUTER_API_KEY` (`Redacted`), and `OPENROUTER_MODEL`.
- `src/SnowLuma.ts`: `SnowLumaClient` service, WebSocket connection management, and event-to-stream bridge.
- `src/features/echo/EchoBot.ts`: Domain logic, message filtering, anti-loop guards, and reply dispatch for "喵喵喵".
- `src/features/link-preview/LinkPreview.ts`: URL extraction, metadata scraping via `HttpClient.HttpClient`, East Asian Width formatting, SSRF guard, and direct reply dispatch.
- `src/features/link-preview/LinkPreviewSites.ts`: Site-specific customization rules (e.g. GitHub, Hacker News), display formatting hooks, and metascraper plugin integration.
- `src/features/link-preview/DecisionFilter.ts`: OpenRouter Decisions API client for semantic link preview filtering and dynamic truncation evaluation.
- `src/features/sauce/Sauce.ts`: `/sauce` command matching, OneBot quote image extraction, and direct reply dispatch.
- `src/features/sauce/SauceNao.ts`: SauceNao API client, similarity threshold verification, and metadata normalization.
- `src/features/danbooru/Danbooru.ts`: `/dbr` command matching, tag limit verification, and reply dispatch.
- `src/features/danbooru/DanbooruClient.ts`: Danbooru random post and local image fetch client with `DANBOORU_USER_AGENT`.
- `src/features/danbooru/DanbooruTagMatcher.ts`: Offline SQLite tag dictionary search with exact, prefix, and compound fuzzy matching.
- `src/features/danbooru/DanbooruFormatter.ts`: Danbooru post title formatting mimicking upstream `humanized_essential_tag_string`.
- `docs/features/danbooru.md`: User-facing documentation for `/dbr` image search.
- `scripts/download-danbooru-tags.ts`: Tag setup script fetching and indexing `tag.sqlite` into `assets/danbooru-tags.sqlite`.
- `src/features/stats/StatsRepository.ts`: SQLite persistence, schema migrations (`SqliteMigrator`), atomic daily upserts, and 30-day / all-time aggregate queries.
- `src/features/stats/StatsClassifier.ts`: Pure event classification (media segments, URLs, poke/reaction notices) and Asia/Shanghai date bucketing.
- `src/features/stats/StatsCollector.ts`: Silent background event consumer for incoming group messages and notices.
- `src/features/stats/StatsRenderer.tsx`: Leaderboard image card rendering pipeline using Satori and Sharp with MiSans typography.
- `src/features/stats/StatsCommand.ts`: Active command router for `/stat`, `/stat all`, and `/me` with cooldown and empty-state fallbacks.
- `docs/features/stats.md`: User-facing documentation for group message statistics.
- `docs/config.md`: Comprehensive environment configuration, offline resource initialization, and storage guide.
- `scripts/download-font.ts`: Font setup script fetching and extracting MiSans from official CDN.
- `src/utils/TextWidth.ts`: Text truncation based on `string-width` and `Intl.Segmenter`.
- `src/utils/MessageGuard.ts`: `isSelfMessage` (shared loop guard) and `isGroupMessage` (group message type guard).
- `test/TestHttpClient.ts`: Test layer helper (`makeTestHttpClient`) bridging mock responses into `HttpClient.HttpClient`.
- `.env.example`: Public template for environment configuration.
- `package.json` & `tsconfig.json`: Project setup configured for TypeScript 7, Bundler module resolution, and tsgo.
- `.oxlintrc.json`: Oxlint configuration extending `@effect/tsgo/oxlint-presets/recommended.json`.

## Runtime/Tooling Preferences

- **Runtime**: Pinned Bun `1.4.4` (managed via `mise.toml`). Node.js is not used for execution.
- **Package Manager**: Bun (`bun install`, `bun.lock`).
- **Linter & Type Checker**: `oxlint` with `@effect/tsgo` type-aware linting. TypeScript `tsc` runs in `noEmit` mode purely for verification.
- **Linter Suppressions**: Use `// oxlint-disable-next-line <plugin>/<rule>` (e.g. `// oxlint-disable-next-line effecttsgo/unstable-api-usage`).

## Testing & QA

- **Framework**: Native `bun:test` (`describe`, `it`, `expect`).
- **No `any` Policy**: Never use `any` or `as any`. Use domain interfaces and double-cast mocks via `as unknown as TargetType` for external SDK structures (`item.context`, `item.event`).
- **HTTP Mocking**: Never mock global `fetch` or use `as unknown as typeof fetch`. Provide a mock `HttpClient.HttpClient` layer using `makeTestHttpClient` from `test/TestHttpClient.ts`.
- **Testing Effect**: Run effects within tests using `await Effect.runPromise(program)`.
- **Config Mocking**: Mock environment configs with `ConfigProvider.fromEnvRecord` wrapped in `ConfigProvider.layer`.
- **Coverage & Edge Cases**:
  - Test positive and negative matches (e.g., exact `"喵喵喵"` vs whitespace `" 喵喵喵 "` or substring `"喵喵"`).
  - Verify loop prevention (handlers ignore self messages via `isSelfMessage`).
  - Test default fallbacks when optional configs are omitted.
- **Meaningful Tests & Avoiding Redundancy**:
  - **No Tautologies or Constant Tests**: Never test bare constants, string literals, or exported timeout/size values directly (e.g. `expect(DEFAULT_USER_AGENT).toBe(...)`). Always test observable behavior exercising that constant instead.
  - **No Framework/Service Echo Tests**: Never test Effect library primitives (like `Queue` or `Stream`) in isolation without involving actual application service logic.
  - **Concrete Assertions**: Avoid weak assertions like `expect(result).toBeDefined()`. Assert concrete data structures and message payloads.
  - **Tiered Testing & No Duplicate Paths**: Test detailed DOM/rule parsing branches in focused unit tests (e.g. `LinkPreviewSites.test.ts`), while keeping integration tests minimal to verify wiring without duplicating rule branches. Do not duplicate identical test execution paths with merely cosmetic variations.
  - **Consolidate Common Setup**: Group default and fallback assertions together when testing configuration records instead of repeating identical environment setup across multiple fragmented test cases.

@node_modules/effect/AGENTS.md
