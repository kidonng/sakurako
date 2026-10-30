/* oxlint-disable effecttsgo/unstable-api-usage */
import { parseSegments, segments } from "@snowluma/sdk/messages";
import type { AnyMessageSegment } from "@snowluma/sdk/types";
import { Effect, Option, Predicate } from "effect";
import { BotConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { formatLogMessagePrefix } from "../../utils/LogFormat.ts";
import { searchSauce } from "./SauceNao.ts";
export const handleSauceMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;

  if (event.post_type === "message_sent" || event.user_id === event.self_id) {
    return;
  }

  const rawSegments: AnyMessageSegment[] = Array.isArray(event.message)
    ? (event.message as unknown as AnyMessageSegment[])
    : Predicate.isString(event.raw_message)
      ? parseSegments(event.raw_message)
      : [];

  const nonReplyAt = rawSegments.filter(
    (s) => s.type !== "reply" && s.type !== "at",
  );

  const hasNonText = nonReplyAt.some((s) => s.type !== "text");
  if (hasNonText) {
    return;
  }

  const text = nonReplyAt
    .map((s) => {
      const data = s.data as { text?: unknown } | undefined;
      return Predicate.isString(data?.text) ? data.text : "";
    })
    .join("")
    .trim();

  if (text !== "/sauce") {
    return;
  }

  const replySegment = rawSegments.find((s) => s.type === "reply");
  const replyData = replySegment?.data as { id?: unknown } | undefined;
  const messageId = Number(replyData?.id);
  if (
    !replySegment ||
    !replyData?.id ||
    !Number.isInteger(messageId) ||
    messageId === 0
  ) {
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

    const quotedSegments: AnyMessageSegment[] = Array.isArray(msgData.message)
      ? (msgData.message as unknown as AnyMessageSegment[])
      : typeof msgData.message === "string"
        ? parseSegments(msgData.message)
        : typeof msgData.raw_message === "string"
          ? parseSegments(msgData.raw_message)
          : [];

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
