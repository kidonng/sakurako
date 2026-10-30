import { Effect, Stream } from "effect";
import { type IncomingMessage, SnowLumaClient } from "../../SnowLuma.ts";
import { formatLogMessagePrefix } from "../../utils/LogFormat.ts";
export const handleIncomingMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;
  if (
    event.raw_message !== "喵喵喵" ||
    event.post_type === "message_sent" ||
    event.user_id === event.self_id
  ) {
    return;
  }

  const prefix = formatLogMessagePrefix(event);
  yield* Effect.logInfo(
    `${prefix} Received '喵喵喵' (${event.message_type}), replying...`,
  );
  yield* Effect.tryPromise(() => item.context.reply("喵喵喵")).pipe(
    Effect.tap(() => Effect.logInfo(`${prefix} Reply sent: 喵喵喵`)),
    Effect.catch((error) =>
      Effect.logError(`${prefix} Failed to reply to message: ${String(error)}`),
    ),
  );
});

export const runEchoBot: Effect.Effect<void, never, SnowLumaClient> =
  Effect.gen(function* () {
    const { messages } = yield* SnowLumaClient;
    yield* Effect.logInfo("EchoBot listening for messages...");
    yield* messages.pipe(Stream.runForEach(handleIncomingMessage));
  });
