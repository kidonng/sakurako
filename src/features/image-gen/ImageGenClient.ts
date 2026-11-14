/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ImageGenConfig } from "../../Config.ts";
import { fetchJson, type HttpFetchError } from "../../utils/HttpClient.ts";
import type { SupportedAspectRatio } from "./ImageGenParser.ts";

export const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";

const OpenRouterImageItemSchema = Schema.Struct({
  b64_json: Schema.optional(Schema.String),
  media_type: Schema.optional(Schema.String),
});

const OpenRouterImageResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.Array(OpenRouterImageItemSchema)),
});

export class ImageGenConfigError extends Schema.TaggedError<
  ImageGenConfigError,
  {
    readonly brand: unique symbol;
  }
>()("ImageGenConfigError", {}) {
  override get message(): string {
    return "ImageGenConfigError: OpenRouter API key or image model is not configured";
  }
}

export class ImageGenApiError extends Schema.TaggedError<
  ImageGenApiError,
  {
    readonly brand: unique symbol;
  }
>()("ImageGenApiError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `ImageGenApiError: ${this.detail}`;
  }
}

export class ImageGenClient extends Context.Service<
  ImageGenClient,
  {
    readonly generateImage: (
      prompt: string,
      aspectRatio?: SupportedAspectRatio,
    ) => Effect.Effect<
      string,
      ImageGenConfigError | ImageGenApiError | HttpFetchError
    >;
  }
>()("sakurako/image-gen/ImageGenClient") {
  static readonly layer = Layer.effect(
    ImageGenClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const config = yield* ImageGenConfig;

      const generateImage = Effect.fnUntraced(function* (
        prompt: string,
        aspectRatio?: SupportedAspectRatio,
      ): Effect.fn.Return<
        string,
        ImageGenConfigError | ImageGenApiError | HttpFetchError
      > {
        const apiKey = config.openrouterApiKey;
        const model = config.openrouterImageModel?.trim();
        if (!apiKey || !model) {
          return yield* new ImageGenConfigError();
        }

        const payload = {
          model,
          prompt,
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        };

        const request = HttpClientRequest.post(OPENROUTER_IMAGES_URL).pipe(
          HttpClientRequest.bearerToken(Redacted.value(apiKey)),
          HttpClientRequest.bodyJsonUnsafe(payload),
        );

        const response = yield* fetchJson(
          request,
          OpenRouterImageResponseSchema,
          { timeoutDuration: "60 seconds" },
        ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

        const first = response.data?.[0];
        const rawBase64 = first?.b64_json?.trim() ?? "";
        const dataUriMediaType = /^data:([^;,]+);base64,/i.exec(rawBase64)?.[1];
        const mediaType = (
          first?.media_type ?? dataUriMediaType
        )?.toLowerCase();
        if (mediaType?.includes("svg")) {
          return yield* new ImageGenApiError({
            detail: "SVG image output is not supported",
          });
        }

        const base64 = rawBase64.replace(/^data:[^;]+;base64,/i, "");
        if (base64.length === 0) {
          return yield* new ImageGenApiError({
            detail: "Empty image data in OpenRouter response",
          });
        }

        return base64;
      });

      return ImageGenClient.of({ generateImage });
    }),
  );
}
