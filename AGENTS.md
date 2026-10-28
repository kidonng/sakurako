# Repository Guidelines

## Project Overview

Sakurako is a QQ bot built with TypeScript, running on Bun and powered by the Effect 4 framework (`effect`, `@effect/platform-bun`). It integrates with a SnowLuma OneBot v11 backend (running via OrbStack at `snowluma.orb.local`) via `@snowluma/sdk`.

Key features include:

- **Echo Bot**: Matches incoming messages strictly equaling `"喵喵喵"` and sends a plain text reply `"喵喵喵"`.
- **Link Preview**: Extracts HTTP/HTTPS links via `get-urls`, fetches OpenGraph/HTML metadata using `metascraper`, applies site-specific custom displays (e.g. GitHub, Hacker News), truncates text according to East Asian Width (`string-width`), guards against SSRF using `ip-address`, and sends structured quote replies (`context.quote`).

## Architecture & Data Flow

The project follows a reactive, decoupled architecture built on Effect 4 services and streams:

```
[SnowLuma Backend] (ws://snowluma.orb.local:3001/)
       │
       ▼ (WebSocket events)
[SnowLumaClient] (src/SnowLuma.ts: Context.Service + Layer.effect)
  - Lifecycle: Effect.acquireRelease with exponential connection retry
  - Bridges events to an unbounded Queue via Effect.runForkWith
       │
       ▼ Stream.fromQueue
[Message Stream] (Stream.Stream<IncomingMessage>)
       │
       ▼ Stream.runForEach (concurrent dispatch)
  ┌────┴───────────────────────────┐
  ▼                                ▼
[EchoBot]                      [LinkPreview]
(src/EchoBot.ts)               (src/LinkPreview.ts)
  - Match: === "喵喵喵"           - Extract: get-urls
  - Reply: context.reply         - Scrape: metascraper
                                 - Format: single/multi preview
                                 - Reply: context.quote
       │                           │
       └─────────────┬─────────────┘
                     ▼
[Entrypoint] (src/index.ts: BunRuntime.runMain)
```

- **Configuration Layer**: `src/Config.ts` reads `SNOWLUMA_WS_URL` and `SNOWLUMA_ACCESS_TOKEN` using Effect's `Config` module.
- **Service Layer**: `SnowLumaClient` encapsulates `SnowLumaWebSocketClient`, managing socket connection, reconnection, and teardown inside a scoped `Layer`.
- **Event Pipeline**: WebSocket message callbacks offer items to an unbounded `Queue`, exposed downstream as a typed `Stream`.
- **Consumer Layer**: `src/index.ts` dispatches messages concurrently to `EchoBot` and `LinkPreview`. Each handler isolates errors per message with `Effect.catch`, ensuring the stream remains active even if individual reply actions fail.

## Key Directories

- `src/`: Core application source files (services, handlers, entrypoint, configuration).
- `test/`: Unit and integration test suites using `bun:test`.
- `.superpowers/specs/`: Architecture specifications and design documents.
- `.superpowers/plans/`: Implementation plans and task breakdowns.
- `docs/`: User-facing feature documentation (e.g. `docs/link-preview.md`).
- `packages/`: Nix packaging derivations (pinned Bun runtime).

## Development Commands

All development tasks use Bun:

- **Run Bot**: `bun start` (or `bun src/index.ts`)
- **Run Tests**: `bun test` (single file: `bun test test/EchoBot.test.ts`)
- **Type Check**: `bun run check` (runs `tsc`, validates types and `verbatimModuleSyntax`)
- **Lint**: `bun run lint` (runs `oxlint` with `oxlint-tsgolint` & `@effect/tsgo` rules)
- **Format**: `bun run format` (runs `bun fmt`)
- **Post-Install Setup**: `bun run prepare` (`effect-tsgo patch --typescript --oxlint`)

## Code Conventions & Common Patterns

### File & Code Naming

- **Files**: PascalCase for services and domain modules (`SnowLuma.ts`, `EchoBot.ts`, `Config.ts`), camelCase for entry points (`index.ts`).
- **Extensions**: Always include `.ts` extensions in local relative imports (e.g. `import { BotConfig } from "./Config.ts"`), required by `"allowImportingTsExtensions": true`.
- **Types vs Values**: Enforce `verbatimModuleSyntax: true` using `import type { ... }` or `import { type Foo, Bar } from "..."`.

### Effect 4 Patterns

- **Services**: Define services extending `Context.Service<Tag, Shape>()("package/Id")`.
- **Layer Construction**: Use `Layer.effect(Service, Effect.gen(...))` combining `Effect.acquireRelease` for resource lifecycle management.
- **Async Execution in Callbacks**: Capture surrounding context with `const context = yield* Effect.context()` and dispatch tasks via `const runFork = Effect.runForkWith(context)` to prevent `effecttsgo(run-effect-inside-effect)` warnings.
- **Tagged Errors**: For internal domain failure channels that do not require Schema serialization, use `Data.TaggedError`. For serialized/wire errors, subclass `Schema.TaggedError` with a brand type parameter:
  ```ts
  export class WebSocketConnectionError extends Schema.TaggedError<
    WebSocketConnectionError,
    {
      readonly brand: unique symbol;
    }
  >()("WebSocketConnectionError", { message: Schema.String }) {}
  ```
- **Error Handling**: Use `Effect.tryPromise` for promise-based APIs and attach `Effect.catch` to handle typed errors. `Effect.promise` defects on rejection; avoid unless defects are expected.
- **Retries**: Compose schedules with `Schedule.exponential(...)` and `Schedule.upTo({ duration: ... })`.
- **Logging**: Use `Effect.logInfo` and `Effect.logError` instead of `console.log`.

## Important Files

- `src/index.ts`: Application entry point dispatching messages concurrently to `handleIncomingMessage` and `handleLinkPreviewMessage` with merged `SnowLumaClient.layer` and `FetchHttpClient.layer` via `BunRuntime.runMain`.
- `src/Config.ts`: Effect `Config.all` schema for `SNOWLUMA_WS_URL` and `SNOWLUMA_ACCESS_TOKEN` (`Redacted`).
- `src/SnowLuma.ts`: `SnowLumaClient` service, WebSocket connection management, and event-to-stream bridge.
- `src/EchoBot.ts`: Domain logic, message filtering, anti-loop guards, and reply dispatch for "喵喵喵".
- `src/LinkPreview.ts`: URL extraction, metadata scraping via `HttpClient.HttpClient`, East Asian Width formatting, SSRF guard, and quote reply dispatch.
- `src/LinkPreviewSites.ts`: Site-specific customization rules (e.g. GitHub, Hacker News), display formatting hooks, and metascraper plugin integration.
- `test/TestHttpClient.ts`: Test layer helper (`makeTestHttpClient`) bridging mock responses into `HttpClient.HttpClient`.
- `src/TextWidth.ts`: Text truncation based on `string-width` and `Intl.Segmenter`.
- `.env.example`: Public template for environment configuration.
- `package.json` & `tsconfig.json`: Project setup configured for TypeScript 7, Bundler module resolution, and tsgo.
- `.oxlintrc.json`: Oxlint configuration extending `@effect/tsgo/oxlint-presets/recommended.json`.

## Runtime/Tooling Preferences

- **Runtime**: Pinned Bun `1.4.4-canary` (managed via `flake.nix` and `packages/bun.nix`). Node.js is not used for execution.
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
  - Verify loop prevention (`post_type: "message_sent"` and `user_id === self_id`).
  - Test default fallbacks when optional configs are omitted.
