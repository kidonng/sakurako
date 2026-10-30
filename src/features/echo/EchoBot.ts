import { Effect, Stream } from "effect";
import { type IncomingMessage, SnowLumaClient } from "../../SnowLuma.ts";
import { formatLogMessagePrefix } from "../../utils/LogFormat.ts";
export const handleIncomingMessage = (
  item: IncomingMessage,
): Effect.Effect<void, never> => {
  const { event } = item;
  if (
    event.raw_message === "喵喵喵" &&
    event.post_type !== "message_sent" &&
    event.user_id !== event.self_id
  ) {
    return Effect.gen(function* () {
      const prefix = formatLogMessagePrefix(event);
      yield* Effect.logInfo(
        `${prefix} Received '喵喵喵' (${event.message_type}), replying...`,
      );
      yield* Effect.tryPromise(() => item.context.reply("喵喵喵"));
      yield* Effect.logInfo(`${prefix} Reply sent: 喵喵喵`);
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(
          `${formatLogMessagePrefix(event)} Failed to reply to message: ${String(error)}`,
        ),
      ),
    );
  }
  return Effect.void;
};

export const runEchoBot: Effect.Effect<void, never, SnowLumaClient> =
  Effect.gen(function* () {
    const { messages } = yield* SnowLumaClient;
    yield* Effect.logInfo("EchoBot listening for messages...");
    yield* messages.pipe(Stream.runForEach(handleIncomingMessage));
  });
