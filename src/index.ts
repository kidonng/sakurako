import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { runEchoBot } from "./EchoBot.ts"
import { SnowLumaClient } from "./SnowLuma.ts"

const MainLive = runEchoBot.pipe(
  Effect.provide(SnowLumaClient.layer)
)
// oxlint-disable-next-line effecttsgo/unstable-api-usage
BunRuntime.runMain(MainLive)
