import { Effect } from "effect";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { formatLogMessagePrefix } from "../../utils/LogFormat.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
export const handleIncomingMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;
  if (event.raw_message !== "喵喵喵" || isSelfMessage(event)) {
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
