import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { handleIncomingMessage } from "./EchoBot.ts";
import { handleLinkPreviewMessage } from "./LinkPreview.ts";
import { SnowLumaClient } from "./SnowLuma.ts";

const MainProgram = Effect.gen(function* () {
  const { messages } = yield* SnowLumaClient;
  yield* Effect.logInfo("Sakurako bot listening for messages...");
  yield* messages.pipe(
    Stream.runForEach((item) =>
      Effect.all(
        [handleIncomingMessage(item), handleLinkPreviewMessage(item)],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.asVoid),
    ),
  );
});

const MainLive = MainProgram.pipe(
  Effect.provide(
    Layer.merge(
      SnowLumaClient.layer,
      // oxlint-disable-next-line effecttsgo/unstable-api-usage
      FetchHttpClient.layer,
    ),
  ),
);
// oxlint-disable-next-line effecttsgo/unstable-api-usage
BunRuntime.runMain(MainLive);
