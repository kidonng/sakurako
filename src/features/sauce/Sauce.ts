/* oxlint-disable effecttsgo/unstable-api-usage */
import { segments } from "@snowluma/sdk/messages";
import type { AnyMessageSegment } from "@snowluma/sdk/types";
import { Effect, Option } from "effect";
import { BotConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { formatLogMessagePrefix } from "../../utils/LogFormat.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
import { parseCommand, parseMessageSegments } from "../../utils/Command.ts";
import { searchSauce } from "./SauceNao.ts";
export const handleSauceMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;

  if (isSelfMessage(event)) {
    return;
  }

  const command = parseCommand(event);
  if (!command || command.text !== "/sauce") {
    return;
  }

  const messageId = command.replyMessageId;
  if (messageId === undefined) {
    yield* Effect.tryPromise(() =>
      item.context.quote("[需引用包含图片的消息]"),
    ).pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to quote reply: ${String(error)}`),
      ),
    );
    return;
  }

  const prefix = formatLogMessagePrefix(event);
  const executeSauce = Effect.gen(function* () {
    yield* Effect.logInfo(
      `${prefix} Received '/sauce', retrieving quoted message ${messageId}...`,
    );
    const client = item.context.client;
    if (!client) {
      yield* Effect.tryPromise(() => item.context.quote("[查询失败]"));
      return;
    }

    const msgData = (yield* Effect.tryPromise(() =>
      client.getMessage(messageId),
    )) as { message?: unknown; raw_message?: unknown };

    const quotedSegments: AnyMessageSegment[] = parseMessageSegments(
      msgData.message,
      msgData.raw_message,
    );

    const imageSegment = quotedSegments.find((s) => s.type === "image");
    if (!imageSegment) {
      yield* Effect.tryPromise(() =>
        item.context.quote("[未在引用的消息中找到图片]"),
      );
      return;
    }

    const imgData = imageSegment.data as
      { url?: unknown; file?: unknown } | undefined;
    const imageUrl =
      typeof imgData?.url === "string" && imgData.url.length > 0
        ? imgData.url
        : typeof imgData?.file === "string" && imgData.file.startsWith("http")
          ? imgData.file
          : undefined;

    if (!imageUrl) {
      yield* Effect.tryPromise(() =>
        item.context.quote("[未在引用的消息中找到图片]"),
      );
      return;
    }

    const config = yield* Effect.option(BotConfig);
    const apiKey = Option.getOrUndefined(config)?.sauceNaoApiKey;
    yield* Effect.logInfo(
      `${prefix} Searching SauceNao for image in message ${messageId}...`,
    );
    const result = yield* searchSauce(imageUrl, apiKey);

    if (!result) {
      yield* Effect.tryPromise(() =>
        item.context.quote("[未找到相似度较高的图片来源]"),
      );
      return;
    }

    yield* Effect.tryPromise(() =>
      item.context.quote(segments.text(result.formattedText)),
    );
    yield* Effect.logInfo(`${prefix} Sauce reply sent successfully.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const prefix = formatLogMessagePrefix(event);
        yield* Effect.logError(
          `${prefix} Sauce handler failed: ${String(error)}`,
        );
        yield* Effect.tryPromise(() => item.context.quote("[查询失败]")).pipe(
          Effect.catch((quoteError) =>
            Effect.logError(
              `Failed to send failure quote: ${String(quoteError)}`,
            ),
          ),
        );
      }),
    ),
  );

  yield* executeSauce;
});
