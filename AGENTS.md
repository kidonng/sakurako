# Repository Guidelines

## Project Overview

Sakurako is an event-driven QQ bot built with TypeScript, running on Bun and powered by the Effect 4 framework (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`). It interfaces with a SnowLuma OneBot v11 backend via `@snowluma/sdk` over WebSocket.

Core features include:

- **Echo Bot**: Matches incoming messages strictly equaling `"喵喵喵"` and sends a plain text reply `"喵喵喵"`.
- **Link Preview**: Extracts HTTP/HTTPS links via `get-urls`, fetches OpenGraph/HTML metadata using `metascraper`, applies site-specific custom extractors (GitHub, Hacker News, Pixiv via `pixiv.cat`, Danbooru), guards against SSRF using `ip-address`, applies local heuristics and OpenRouter multimodal decision filtering, truncates text according to East Asian Width (`string-width`), and sends structured replies.
- **Image Sauce**: Matches incoming messages strictly equaling `"/sauce"` replying to an image, queries the SauceNao API across 15 curated ACG databases with similarity tolerance and origin prioritization, and replies with work title, author, and source link.
- **Message Statistics**: Silently aggregates group member messages by type (total, media, links, interactions) into SQLite daily buckets using `@effect/sql-sqlite-bun` and `SqliteMigrator`. Generates high-density leaderboard image cards via Satori + Sharp (`/stat`, `/stat all`), replies with personal stats breakdowns (`/me`), and enforces a 5-second per-group cooldown.
- **Danbooru**: Matches incoming messages starting with `"/dbr"`, processes tags using an offline bilingual SQLite dictionary (`assets/danbooru-tags.sqlite`) with Levenshtein fuzzy matching, queries Danbooru random SFW posts, and replies with official format title and image.

## Architecture & Data Flow

The project follows a reactive, push-to-pull decoupled architecture built on Effect 4 services and streams:

```
[SnowLuma Backend] (ws://snowluma.orb.local:3001/)
       │
       ▼ (WebSocket events push via @snowluma/sdk)
[SnowLumaClient] (src/SnowLuma.ts: Context.Service + Layer.effect)
  - Connection managed via Effect.acquireRelease with exponential retry
  - Callbacks bridge events into unbounded Queues via Queue.offerUnsafe
       │
       ▼ Stream.fromQueue
[Message & Notice Streams] (Stream.Stream<IncomingMessage> & Stream.Stream<IncomingNotice>)
       │
       ▼ Stream.filter(shouldProcessEvent) (Dev isolation vs. Prod routing)
       │
       ▼ Stream.runForEach (Effect.all with unbounded concurrency)
  ┌────┴───────────────┬───────────────────┬───────────────────┬───────────────────┬───────────────────┐
  ▼                    ▼                   ▼                   ▼                   ▼                   ▼
[EchoBot]          [LinkPreview]       [Sauce]             [Danbooru]          [StatsCollector]    [StatsCommand]
(src/features/     (src/features/      (src/features/      (src/features/      (src/features/      (src/features/
 echo/EchoBot.ts)   link-preview/)      sauce/Sauce.ts)     danbooru/)          stats/Collector.ts) stats/Command.ts)
  - "喵喵喵"           - metascraper       - /sauce            - /dbr [tags]       - silent logging    - /stat, /me
  - context.reply      - OpenRouter LLM    - SauceNao API      - DanbooruClient    - StatsRepository   - Satori + Sharp
       │                   │                   │                   │                   │                   │
       └───────────────────┴───────────────────┴───────────────────┴───────────────────┴───────────────────┘
                                   ▼
[Entrypoint] (src/index.ts: BunRuntime.runMain)
```

- **Configuration Layer**: `src/Config.ts` reads `SNOWLUMA_WS_URL`, `SNOWLUMA_ACCESS_TOKEN` (`Redacted`), optional `SAUCENAO_API_KEY` (`Redacted`), `OPENROUTER_API_KEY` (`Redacted`), `OPENROUTER_DECISION_MODEL`, `DEV_MODE`, and `DEV_GROUP_ID` using Effect's `Config` schema.
- **Service Layer**: Services encapsulate domain boundaries via `Context.Service` and companion static `.layer` factories (`SnowLumaClient`, `DanbooruClient`, `DanbooruTagMatcher`, `StatsRepository`, `StatsCooldown`, `StatsRenderer`).
- **Event Pipeline**: WebSocket callbacks offer messages and notices to unbounded Queues synchronously via `Queue.offerUnsafe`, exposed downstream as typed `messages` and `notices` streams.
- **Dispatch & Isolation**: `src/index.ts` pre-filters streams with `shouldProcessEvent` and fans out each event to handlers concurrently via `Effect.all(..., { concurrency: "unbounded", discard: true })`. Every handler traps errors with `Effect.catch`/`Effect.catchDefect`, ensuring an error in one feature never tears down the event stream.

## Key Directories

```
.
├── src/                           # Application source code
│   ├── features/                  # Domain feature modules
│   │   ├── echo/                  # Heartbeat "喵喵喵" handler
│   │   ├── link-preview/          # URL scraping, site rules, and LLM decision filter
│   │   ├── sauce/                 # SauceNao reverse image search handler & client
│   │   ├── danbooru/              # /dbr search, bilingual tag matcher, post formatter
│   │   └── stats/                 # Message statistics, SQLite repository, Satori card renderer
│   ├── utils/                     # Shared utilities (MessageGuard, HttpClient, TextWidth, Command)
│   ├── Config.ts                  # Bot configuration schema
│   ├── SnowLuma.ts                # WebSocket client service & Stream bridge
│   └── index.ts                   # Main application entry point & layer composition
├── test/                          # Unit and integration test suites (bun:test)
│   ├── features/                  # Domain feature tests
│   ├── utils/                     # Utility tests
│   ├── TestHttpClient.ts          # Effect HttpClient test layer mock helper
│   └── TestMessage.ts             # OneBot message and context mock generator
├── scripts/                       # CLI scripts & offline resource downloaders
│   ├── download-font.ts           # Downloads MiSans-Normal.ttf for Satori card rendering
│   ├── download-danbooru-tags.ts  # Downloads & indexes Danbooru translation table SQLite
│   └── inspect-msg.ts             # OneBot message inspection CLI utility
├── docs/                          # Architecture & feature documentation
│   ├── config.md                  # Deployment, environment variables, and persistence guide
│   └── features/                  # User-facing specs for each feature
├── assets/                        # Static offline assets (gitignored, persisted)
│   ├── fonts/MiSans-Normal.ttf    # Required font for image card generation
│   └── danbooru-tags.sqlite       # Offline Danbooru tag dictionary database
├── data/                          # Runtime persistent storage (volume mount)
│   └── stats.db                   # SQLite database for group message statistics
└── .superpowers/                  # Engineering design specs and implementation plans
    ├── specs/                     # Architecture and feature design documents
    └── plans/                     # TDD execution plans
```

## Development Commands

All development tasks use Bun:

| Task | Package Script | Exact Invocation | Description / Notes |
|:---|:---|:---|:---|
| **Run Bot** | `bun start` | `bun src/index.ts` | Runs the main bot entry point. |
| **Run Tests** | `bun test` | `bun test` | Runs unit & integration test suites using native `bun:test`. Can target files: `bun test test/features/echo/EchoBot.test.ts`. |
| **Type Check** | `bun run check` | `tsc` | Pure TypeScript type validation (`noEmit: true`, bundler module resolution, `verbatimModuleSyntax`). |
| **Lint** | `bun run lint` | `oxlint` | Runs Oxlint with `@effect/tsgo` type-aware lint rules. |
| **Format** | `bun run format` | `bun fmt` | Formats codebase using Bun's native formatter. |
| **Auto-Fix** | `bun run fix` | `oxlint --fix; knip --fix; bun fmt` | Sequentially fixes lint errors, unused exports/dependencies, and formatting. |
| **Unused Code** | `bun run knip` | `knip` | Verifies unused exports, files, and dependencies based on `knip.json`. |
| **Download Font** | `bun run download-font` | `bun scripts/download-font.ts` | Fetches MiSans (`MiSans-Normal.ttf`) to `assets/fonts/` for Satori card rendering. |
| **Download Tags** | `bun run download-tags` | `bun scripts/download-danbooru-tags.ts` | Fetches & indexes bilingual Danbooru tags database into `assets/danbooru-tags.sqlite` (~24 MB). |
| **Inspect Msg** | `bun run inspect-msg` | `bun scripts/inspect-msg.ts <id>` | Helper CLI to inspect raw OneBot message payloads by ID. |
| **Prepare** | `bun run prepare` | `effect-tsgo patch --typescript --oxlint` | Patches TypeScript compiler and Oxlint with `@effect/tsgo` plugins. |

## Code Conventions & Common Patterns

### File & Code Naming
- **Files**: PascalCase for services, domain modules, and components (`SnowLuma.ts`, `EchoBot.ts`, `Config.ts`, `StatsRenderer.tsx`), camelCase for entry points and scripts (`index.ts`, `inspect-msg.ts`).
- **Extensions**: Always include explicit `.ts` or `.tsx` extensions in local relative imports (e.g. `import { BotConfig } from "./Config.ts"`), required by `"allowImportingTsExtensions": true`.
- **Types vs Values**: Enforce `verbatimModuleSyntax: true` using `import type { ... }` or `import { type Foo, Bar } from "..."`.

### Effect 4 Repository Patterns
General Effect 4 patterns follow `@node_modules/effect/AGENTS.md`. Note the repository-specific requirements:

- **Branded Schema Tagged Errors**: Due to `effecttsgo/schema-class-missing-brand`, always provide `{ readonly brand: unique symbol; }` as the second type argument to `Schema.TaggedError`:
  ```ts
  export class DanbooruNotFoundError extends Schema.TaggedError<
    DanbooruNotFoundError,
    {
      readonly brand: unique symbol;
    }
  >()("DanbooruNotFoundError", { queryTags: Schema.String }) {}
  ```
- **Callback Ingestion**: In non-Effect callbacks (e.g. WebSocket listeners), offer items synchronously via `Queue.offerUnsafe` rather than creating fibers.
- **Directory Bootstrapping**: Use `Layer.effectDiscard` to guarantee directory creation before database or asset initializations (e.g. `EnsureDataDir`, `EnsureAssetsDir` in `src/index.ts`).
- **Dynamic Layer Branching**: Use `Layer.unwrap` when choosing an implementation dynamically at boot (e.g. `DanbooruTagMatcher.live()` selecting between SQLite and English-only fallback).

### Handler Guards & Event Isolation
- **Loop Prevention (`isSelfMessage`)**: Every incoming message listener MUST call `if (isSelfMessage(item.event)) return;` from `src/utils/MessageGuard.ts` at entry. Never re-implement the `post_type === "message_sent" || user_id === self_id` check inline, and never treat missing `user_id` as self-sent.
- **Group Message Filter (`isGroupMessage`)**: Handlers operating strictly on group messages use `isGroupMessage(event)` to ensure `message_type === "group"` and valid numeric `group_id` and `user_id`.
- **Dev Isolation (`shouldProcessEvent`)**: Filters events at the stream level based on `DEV_MODE` and `DEV_GROUP_ID`.
- **Per-Event Error Isolation**: Feature handlers must catch errors with `Effect.catch`/`Effect.catchDefect` so failures never terminate the root stream.

## Important Files

- `src/index.ts`: Application entry point; wires layers, initializes schemas, and runs message/notice streams concurrently with `BunRuntime.runMain`.
- `src/Config.ts`: Effect `Config.all` schema defining environment variables, secrets (`Redacted`), and dev mode options.
- `src/SnowLuma.ts`: `SnowLumaClient` service, WebSocket lifecycle management (`acquireRelease`), and event queue bridging.
- `src/utils/MessageGuard.ts`: `isSelfMessage`, `isGroupMessage`, and `shouldProcessEvent` guards.
- `src/utils/HttpClient.ts`: Resilient HTTP client wrapper around `effect/http` with charset sniffing (GB18030/GBK), size limits, and stream body cleanup.
- `src/utils/Command.ts`: OneBot message segment parsing (`parseMessageSegments`), image extraction (`extractMessageImages`), and command parsing (`parseCommand`).
- `src/utils/TextWidth.ts`: CJK-aware string width measurement and grapheme-cluster truncation.
- `src/features/echo/EchoBot.ts`: Heartbeat echo handler for `"喵喵喵"`.
- `src/features/link-preview/LinkPreview.ts`: URL extraction, SSRF guard, metadata scraping, OpenRouter decision filtering, and direct reply dispatch.
- `src/features/link-preview/LinkPreviewSites.ts`: Custom scraping and display rules for GitHub, Hacker News, Pixiv, and Danbooru.
- `src/features/link-preview/DecisionFilter.ts`: OpenRouter Decisions API integration for semantic preview filtering.
- `src/features/sauce/Sauce.ts`: `/sauce` command matching, quoted image extraction, and reply dispatch.
- `src/features/sauce/SauceNao.ts`: SauceNao client, 15-database index weighting, and origin priority normalization.
- `src/features/danbooru/Danbooru.ts`: `/dbr` command matching, tag limit check (max 2), and reply dispatch.
- `src/features/danbooru/DanbooruClient.ts`: Danbooru API client for random SFW post queries and image downloads.
- `src/features/danbooru/DanbooruTagMatcher.ts`: Offline SQLite tag dictionary search with exact, prefix, and Levenshtein fuzzy matching.
- `src/features/danbooru/DanbooruFormatter.ts`: Danbooru post title formatting separating characters, series, and artists.
- `src/features/stats/StatsRepository.ts`: SQLite persistence, schema migrations (`SqliteMigrator`), daily upserts, and leaderboard queries.
- `src/features/stats/StatsClassifier.ts`: Pure event classification (media, links, pokes, reactions) and Shanghai date bucketing.
- `src/features/stats/StatsCollector.ts`: Silent background message and notice consumer logging stats to SQLite.
- `src/features/stats/StatsRenderer.tsx`: Leaderboard card renderer generating PNGs using Satori (JSX) and Sharp.
- `src/features/stats/StatsCommand.ts`: Active command router for `/stat`, `/stat all`, and `/me` with 5s cooldown.
- `scripts/download-font.ts`: Font setup script fetching and extracting MiSans from official CDN.
- `scripts/download-danbooru-tags.ts`: Tag setup script fetching and indexing `tag.sqlite` into `assets/danbooru-tags.sqlite`.
- `scripts/inspect-msg.ts`: CLI utility querying OneBot action `get_msg` to inspect message structure and JSON payloads.
- `docs/config.md`: Configuration, deployment, and static resource setup guide.

## Runtime/Tooling Preferences

- **Runtime**: Pinned **Bun `1.4.4`** (managed via `mise.toml` / `mise.lock`). Node.js is **not** used for execution.
- **Package Manager**: Bun (`bun install`, `bun.lock`).
- **Linter & Type Checker**: `oxlint` with `@effect/tsgo` type-aware linting (`oxlint-tsgolint`). TypeScript `tsc` (`7.0.2`) runs in `noEmit: true` mode purely for verification.
- **Dependency Overrides**:
  ```json
  "overrides": {
    "re2": "npm:empty-npm-package@1.0.0"
  }
  ```
  Stubs native C++ `re2` pulled in transitively by scraping libraries with an empty package.
- **Linter Suppressions**: Use `// oxlint-disable-next-line <plugin>/<rule>` or file-level `/* oxlint-disable <plugin>/<rule> */` (e.g. `/* oxlint-disable effecttsgo/unstable-api-usage */`).

## Testing & QA

- **Framework**: Native `bun:test` (`describe`, `it`, `expect`). No Jest/Mocha/Vitest dependencies.
- **Running Effect in Tests**:
  - `await Effect.runPromise(program)`: Standard execution of async Effect programs.
  - `await Effect.runPromiseExit(program)`: Used to assert failures without throwing (e.g. `expect(Exit.isFailure(exit)).toBe(true)`).
  - `Effect.flip`: Inverts failure/success channels to inspect expected tagged errors directly:
    ```ts
    const error = await Effect.runPromise(program.pipe(Effect.flip));
    expect(error).toBeInstanceOf(HttpNotFoundError);
    expect(error._tag).toBe("HttpNotFoundError");
    ```
- **HTTP Mocking**: **NEVER** mock global `fetch` or use `as unknown as typeof fetch`. Always provide a mock `HttpClient.HttpClient` layer using `makeTestHttpClient` from `test/TestHttpClient.ts`:
  ```ts
  const httpLayer = makeTestHttpClient((req) => {
    return new Response(JSON.stringify(mockData), { status: 200 });
  });
  await Effect.runPromise(program.pipe(Effect.provide(httpLayer)));
  ```
- **Config Mocking**: Mock environment configs with `ConfigProvider.fromEnvRecord` wrapped in `ConfigProvider.layer`. Never mutate `process.env`.
- **External SDK Mocking**: Never use `any`. Use TypeScript double-casting (`as unknown as TargetType`) to mock complex third-party shapes (`IncomingMessage`, `SnowLumaWebSocketClient`, `FileSystem`).
- **In-Memory Database Testing**: Test SQLite repositories with `SqliteClient.layer({ filename: ":memory:" })`.
- **Meaningful Tests & Quality Invariants**:
  - **No Tautologies or Constant Tests**: Never test bare constants or string literals in isolation. Always test observable behavior exercising that logic.
  - **Concrete Assertions**: Avoid vague checks like `expect(result).toBeDefined()`. Assert concrete data structures, exact string fragments, or magic bytes (e.g. PNG header `[0x89, 0x50, 0x4e, 0x47]`).
  - **Positive & Negative Matching**: Always test matching inputs against edge cases (whitespace, extra tokens, missing quote, unexpected segments).
  - **Anti-Loop Verification**: Every message handler test must explicitly verify loop prevention (`user_id === self_id` produces zero replies).
  - **Tiered Testing**: Structure tests logically:
    1. Pure utilities (`TextWidth.test.ts`, `Command.test.ts`)
    2. Domain engines & clients (`SauceNao.test.ts`, `DanbooruClient.test.ts`)
    3. Bot command handlers (`SauceBot.test.ts`, `LinkPreviewBot.test.ts`)
    4. End-to-end integration (`StatsIntegration.test.ts`)

@node_modules/effect/AGENTS.md
