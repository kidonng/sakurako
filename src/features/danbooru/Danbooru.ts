/* oxlint-disable effecttsgo/unstable-api-usage */
import { segments } from "@snowluma/sdk/messages";
import type { AnyMessageSegment } from "@snowluma/sdk/types";
import { Effect } from "effect";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { parseCommand } from "../../utils/Command.ts";
import {
  formatErrorDetail,
  formatLogMessagePrefix,
} from "../../utils/LogFormat.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
import { DanbooruClient } from "./DanbooruClient.ts";
import { formatDanbooruTitle } from "./DanbooruFormatter.ts";
import { DanbooruTagMatcher } from "./DanbooruTagMatcher.ts";

export const handleDanbooruMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;

  if (isSelfMessage(event)) {
    return;
  }

  const command = parseCommand(event);
  if (!command) {
    return;
  }

  const text = command.text.trim();
  if (text !== "/dbr" && !text.startsWith("/dbr ")) {
    return;
  }

  const prefix = formatLogMessagePrefix(event);
  const rawQuery = text.slice(4).trim();

  const executeDanbooru = Effect.gen(function* () {
    yield* Effect.logInfo(
      `${prefix} Received '/dbr'${rawQuery ? ` with query "${rawQuery}"` : ""}, processing...`,
    );

    const matcher = yield* DanbooruTagMatcher;
    const client = yield* DanbooruClient;

    let searchTags: readonly string[] = [];
    let isModified = false;

    if (rawQuery.length > 0) {
      const matchResult = yield* matcher.matchQuery(rawQuery);
      if (matchResult.tags.length > 2) {
        yield* Effect.tryPromise(() =>
          item.context.reply("[标签数量超出限制，最多支持 2 个]"),
        );
        return;
      }
      if (matchResult.tags.length === 0) {
        yield* Effect.tryPromise(() =>
          item.context.reply("[未找到匹配的标签]"),
        );
        return;
      }
      searchTags = matchResult.tags;
      isModified = matchResult.isModified;
    }

    const post = yield* client.getRandomPost(searchTags).pipe(
      Effect.catchTags({
        DanbooruNotFoundError: () =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              item.context.reply("[未找到符合条件的图片]"),
            );
            return undefined;
          }),
        DanbooruRateLimitError: () =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              item.context.reply("[Danbooru 请求过于频繁，请稍后再试]"),
            );
            return undefined;
          }),
        DanbooruApiError: () =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              item.context.reply("[Danbooru 接口请求失败]"),
            );
            return undefined;
          }),
      }),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError(
            `${prefix} Danbooru client error: ${String(error)}`,
          );
          yield* Effect.tryPromise(() =>
            item.context.reply("[Danbooru 接口请求失败]"),
          );
          return undefined;
        }),
      ),
    );

    if (!post) {
      return;
    }

    const imageUrl = post.large_file_url ?? post.file_url;
    if (!imageUrl) {
      yield* Effect.tryPromise(() =>
        item.context.reply("[未获取到有效图片链接]"),
      );
      return;
    }

    const downloadedImage = yield* client.downloadImage(imageUrl).pipe(
      Effect.catch((downloadError) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `${prefix} Failed to download image for post #${post.id} from ${imageUrl}: ${String(downloadError)}`,
          );
          yield* Effect.tryPromise(() =>
            item.context.reply("[下载图片失败]"),
          );
          return undefined;
        }),
      ),
    );

    if (!downloadedImage) {
      return;
    }

    const title = formatDanbooruTitle(post);
    let textContent = "";
    if (isModified && searchTags.length > 0) {
      textContent += `🔍 ${searchTags.join(" ")}\n`;
    }
    textContent += title;

    const replySegments: AnyMessageSegment[] = [
      segments.text(textContent),
      segments.image(downloadedImage),
    ];

    yield* Effect.tryPromise(() => item.context.reply(replySegments));
    yield* Effect.logInfo(
      `${prefix} Sent Danbooru post #${post.id} with title "${title}".`,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(
        `${prefix} Danbooru handler failed: ${formatErrorDetail(error)}`,
      ),
    ),
  );

  yield* executeDanbooru;
});
