import { Effect, Stream } from "effect"
import { type IncomingMessage, SnowLumaClient } from "./SnowLuma.ts"

export const handleIncomingMessage = (
  item: IncomingMessage
): Effect.Effect<void, never> => {
  if (item.event.raw_message === "喵喵喵") {
    return Effect.gen(function*() {
      yield* Effect.logInfo(
        `Received '喵喵喵' from user ${item.event.user_id} (${item.event.message_type}), replying...`
      )
      yield* Effect.tryPromise(() => item.context.reply("喵喵喵"))
      yield* Effect.logInfo("Reply sent: 喵喵喵")
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to reply to message: ${String(error)}`)
      )
    )
  }
  return Effect.void
}

export const runEchoBot: Effect.Effect<void, never, SnowLumaClient> = Effect.gen(function*() {
  const { messages } = yield* SnowLumaClient
  yield* Effect.logInfo("EchoBot listening for messages...")
  yield* messages.pipe(
    Stream.runForEach(handleIncomingMessage)
  )
})
