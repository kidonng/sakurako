/* oxlint-disable effecttsgo/unstable-api-usage */
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import { BotConfig } from "./Config.ts";
import { handleIncomingMessage } from "./features/echo/EchoBot.ts";
import { handleLinkPreviewMessage } from "./features/link-preview/LinkPreview.ts";
import { handleSauceMessage } from "./features/sauce/Sauce.ts";
import { handleDanbooruMessage } from "./features/danbooru/Danbooru.ts";
import { DanbooruClient } from "./features/danbooru/DanbooruClient.ts";
import { DanbooruTagMatcher } from "./features/danbooru/DanbooruTagMatcher.ts";
import {
  handleStatsMessage,
  handleStatsNotice,
} from "./features/stats/StatsCollector.ts";
import { handleStatsCommand } from "./features/stats/StatsCommand.ts";
import { StatsCooldown } from "./features/stats/StatsCooldown.ts";
import { StatsRenderer } from "./features/stats/StatsRenderer.tsx";
import { StatsRepository } from "./features/stats/StatsRepository.ts";
import { SnowLumaClient } from "./SnowLuma.ts";
import { shouldProcessEvent } from "./utils/MessageGuard.ts";

export const logStartupInfo = Effect.fnUntraced(function* (
  client: SnowLumaWebSocketClient | undefined,
  config: BotConfig,
) {
  const loginInfo = yield* Effect.tryPromise({
    try: async () => {
      if (typeof client?.getLoginInfo === "function") {
        return await client.getLoginInfo();
      }
      return undefined;
    },
    catch: () => undefined,
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

  if (loginInfo?.nickname && loginInfo?.user_id) {
    yield* Effect.logInfo(
      `Sakurako bot listening for messages and notices as ${loginInfo.nickname} (${loginInfo.user_id})...`,
    );
  } else {
    yield* Effect.logInfo("Sakurako bot listening for messages and notices...");
  }

  if (config.devMode) {
    yield* Effect.logInfo(
      `Running in DEV MODE (only group ${config.devGroupId ?? "none"} will be processed)`,
    );
  } else if (config.devGroupId !== undefined) {
    yield* Effect.logInfo(
      `Running in PROD MODE (ignoring dev group ${config.devGroupId})`,
    );
  }

  if (config.sauceNaoApiKey) {
    yield* Effect.logInfo(
      "Sauce feature enabled (SauceNao API key configured)",
    );
  }

  if (config.openrouterApiKey) {
    yield* Effect.logInfo(
      `Decision filter enabled using model ${config.openrouterDecisionModel}`,
    );
  }
});

export const MainProgram = Effect.gen(function* () {
  const config = yield* BotConfig;
  const repo = yield* StatsRepository;
  yield* repo.initSchema;

  const { client, messages, notices } = yield* SnowLumaClient;
  yield* logStartupInfo(client, config);
  const processMessages = messages.pipe(
    Stream.filter((item) => shouldProcessEvent(item.event, config)),
    Stream.runForEach((item) =>
      Effect.all(
        [
          handleIncomingMessage(item),
          handleLinkPreviewMessage(item),
          handleSauceMessage(item),
          handleDanbooruMessage(item),
          handleStatsMessage(item),
          handleStatsCommand(item),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
    ),
  );

  const processNotices = notices.pipe(
    Stream.filter((item) => shouldProcessEvent(item.event, config)),
    Stream.runForEach((item) =>
      Effect.all([handleStatsNotice(item)], {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
  );

  yield* Effect.all([processMessages, processNotices], {
    concurrency: "unbounded",
    discard: true,
  });
});

const EnsureDataDir = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory("data", { recursive: true });
  }),
).pipe(Layer.provide(BunFileSystem.layer));

const SqliteLive = SqliteClient.layer({ filename: "data/stats.db" });
const StatsRepoLive = StatsRepository.layer.pipe(
  Layer.provide(SqliteLive),
  Layer.provideMerge(EnsureDataDir),
);
const EnsureAssetsDir = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory("assets", { recursive: true });
  }),
).pipe(Layer.provide(BunFileSystem.layer));

const DanbooruTagMatcherLive = DanbooruTagMatcher.live().pipe(
  Layer.provideMerge(EnsureAssetsDir),
  Layer.provide(BunFileSystem.layer),
);

const DanbooruClientLive = DanbooruClient.layer.pipe(
  Layer.provide(FetchHttpClient.layer),
);

export const MainLive = MainProgram.pipe(
  Effect.provide(
    Layer.mergeAll(
      SnowLumaClient.layer,
      FetchHttpClient.layer,
      StatsRepoLive,
      StatsRenderer.layer,
      StatsCooldown.layer,
      DanbooruTagMatcherLive,
      DanbooruClientLive,
    ),
  ),
);

if (import.meta.main) {
  BunRuntime.runMain(MainLive);
}
