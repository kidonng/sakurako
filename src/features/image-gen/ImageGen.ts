/* oxlint-disable effecttsgo/unstable-api-usage */
import { segments } from "@snowluma/sdk/messages";
import { Effect } from "effect";
import { ImageGenConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { parseCommand } from "../../utils/Command.ts";
import {
  formatErrorDetail,
  formatLogMessagePrefix,
} from "../../utils/LogFormat.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
import { ImageGenClient } from "./ImageGenClient.ts";
import {
  parseImageGenInput,
  SUPPORTED_ASPECT_RATIOS,
} from "./ImageGenParser.ts";

const USAGE_HINT = `[请输入提示词，例如：/gen 16:9 一只橘猫（支持比例：${SUPPORTED_ASPECT_RATIOS.join("、")}）]`;

export const handleImageGenMessage = Effect.fnUntraced(function* (
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

  const parsed = parseImageGenInput(command.text);
  if (!parsed) {
    return;
  }

  const prefix = formatLogMessagePrefix(event);

  const executeImageGen = Effect.gen(function* () {
    const config = yield* ImageGenConfig;
    if (!config.openrouterApiKey || !config.openrouterImageModel) {
      yield* Effect.tryPromise(() => item.context.reply("[生图功能未启用]"));
      return;
    }

    if (parsed.prompt.length === 0) {
      yield* Effect.tryPromise(() => item.context.reply(USAGE_HINT));
      return;
    }

    yield* Effect.logInfo(
      `${prefix} Received '/gen'${parsed.aspectRatio ? ` (${parsed.aspectRatio})` : ""}, generating image...`,
    );

    const client = yield* ImageGenClient;
    const base64 = yield* client
      .generateImage(parsed.prompt, parsed.aspectRatio)
      .pipe(
        Effect.catchTags({
          ImageGenConfigError: () =>
            Effect.gen(function* () {
              yield* Effect.tryPromise(() =>
                item.context.reply("[生图功能未启用]"),
              );
              return undefined;
            }),
          HttpRateLimitError: () =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                `${prefix} Image generation rate limited by OpenRouter.`,
              );
              yield* Effect.tryPromise(() =>
                item.context.reply("[生图请求过于频繁，请稍后再试]"),
              );
              return undefined;
            }),
        }),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              `${prefix} Image generation failed: ${formatErrorDetail(error)}`,
            );
            yield* Effect.tryPromise(() => item.context.reply("[生图失败]"));
            return undefined;
          }),
        ),
      );

    if (!base64) {
      return;
    }

    yield* Effect.tryPromise(() =>
      item.context.reply(segments.image(`base64://${base64}`)),
    );
    yield* Effect.logInfo(`${prefix} Sent generated image.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(
        `${prefix} ImageGen handler failed: ${formatErrorDetail(error)}`,
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError(
        `${prefix} Defect in ImageGen handler: ${formatErrorDetail(defect)}`,
      ),
    ),
  );

  yield* executeImageGen;
});
