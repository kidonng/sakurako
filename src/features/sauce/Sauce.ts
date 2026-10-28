/* oxlint-disable effecttsgo/unstable-api-usage */
import { parseSegments } from "@snowluma/sdk/messages";
import type { AnyMessageSegment } from "@snowluma/sdk/types";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { BotConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { searchSauce } from "./SauceNao.ts";

export function handleSauceMessage(
  item: IncomingMessage,
): Effect.Effect<void, never, HttpClient.HttpClient> {
  const { event } = item;

  if (event.post_type === "message_sent" || event.user_id === event.self_id) {
    return Effect.void;
  }

  const rawSegments: AnyMessageSegment[] = Array.isArray(event.message)
    ? (event.message as unknown as AnyMessageSegment[])
    : typeof event.raw_message === "string"
      ? parseSegments(event.raw_message)
      : [];

  const nonReplyAt = rawSegments.filter(
    (s) => s.type !== "reply" && s.type !== "at",
  );

  const hasNonText = nonReplyAt.some((s) => s.type !== "text");
  if (hasNonText) {
    return Effect.void;
  }

  const text = nonReplyAt
    .map((s) => {
      const data = s.data as { text?: unknown } | undefined;
      return typeof data?.text === "string" ? data.text : "";
    })
    .join("")
    .trim();

  if (text !== "/sauce") {
    return Effect.void;
  }

  const replySegment = rawSegments.find((s) => s.type === "reply");
  if (!replySegment) {
    return Effect.tryPromise(() =>
      item.context.quote("未在引用的消息中找到图片"),
    ).pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to quote reply: ${String(error)}`),
      ),
      Effect.asVoid,
    );
  }

  const replyData = replySegment.data as { id?: unknown } | undefined;
  const messageId = Number(replyData?.id);
  if (!replyData?.id || isNaN(messageId) || messageId <= 0) {
    return Effect.tryPromise(() =>
      item.context.quote("未在引用的消息中找到图片"),
    ).pipe(
      Effect.catch((error) =>
        Effect.logError(`Failed to quote reply: ${String(error)}`),
      ),
      Effect.asVoid,
    );
  }

  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `Received '/sauce' from user ${event.user_id}, retrieving quoted message ${messageId}...`,
    );

    const client = item.context.client;
    if (!client) {
      yield* Effect.tryPromise(() =>
        item.context.quote("查询失败，请稍后重试"),
      );
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
        item.context.quote("未在引用的消息中找到图片"),
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
        item.context.quote("未在引用的消息中找到图片"),
      );
      return;
    }

    const config = yield* Effect.option(BotConfig);
    const apiKey =
      config._tag === "Some" ? config.value.sauceNaoApiKey : undefined;

    yield* Effect.logInfo(
      `Searching SauceNao for image in message ${messageId}...`,
    );
    const result = yield* searchSauce(imageUrl, apiKey);

    if (!result) {
      yield* Effect.tryPromise(() =>
        item.context.quote("未找到相似度较高的图片来源"),
      );
      return;
    }

    yield* Effect.tryPromise(() => item.context.quote(result.formattedText));
    yield* Effect.logInfo("Sauce reply sent successfully.");
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logError(`Sauce handler failed: ${String(error)}`);
        yield* Effect.tryPromise(() =>
          item.context.quote("查询失败，请稍后重试"),
        ).pipe(
          Effect.catch((quoteError) =>
            Effect.logError(
              `Failed to send failure quote: ${String(quoteError)}`,
            ),
          ),
        );
      }),
    ),
  );
}
