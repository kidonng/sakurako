/* oxlint-disable effecttsgo/unstable-api-usage */
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import { handleIncomingMessage } from "./features/echo/EchoBot.ts";
import { handleLinkPreviewMessage } from "./features/link-preview/LinkPreview.ts";
import { handleSauceMessage } from "./features/sauce/Sauce.ts";
import {
  handleStatsMessage,
  handleStatsNotice,
} from "./features/stats/StatsCollector.ts";
import { handleStatsCommand } from "./features/stats/StatsCommand.ts";
import { StatsRenderer } from "./features/stats/StatsRenderer.ts";
import { StatsRepository } from "./features/stats/StatsRepository.ts";
import { SnowLumaClient } from "./SnowLuma.ts";

export {
  handleStatsMessage as handleStatsCollectorMessage,
  handleStatsNotice as handleStatsCollectorNotice,
};

export const MainProgram = Effect.gen(function* () {
  const repo = yield* StatsRepository;
  yield* repo.initSchema;

  const { messages, notices } = yield* SnowLumaClient;
  yield* Effect.logInfo("Sakurako bot listening for messages and notices...");

  const processMessages = messages.pipe(
    Stream.runForEach((item) =>
      Effect.all(
        [
          handleIncomingMessage(item),
          handleLinkPreviewMessage(item),
          handleSauceMessage(item),
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
    Stream.runForEach((item) =>
      Effect.all(
        [
          handleStatsNotice(item),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      ),
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

export const MainLive = MainProgram.pipe(
  Effect.provide(
    Layer.mergeAll(
      SnowLumaClient.layer,
      FetchHttpClient.layer,
      StatsRepoLive,
      StatsRenderer.layer,
    ),
  ),
);

if (import.meta.main) {
  BunRuntime.runMain(MainLive);
}
