/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  Url,
} from "effect/http";
import {
  DANBOORU_USER_AGENT,
  executeWithResponse,
  fetchJson,
} from "../../utils/HttpClient.ts";

export const DanbooruPostSchema = Schema.Struct({
  id: Schema.Finite,
  file_url: Schema.optional(Schema.String),
  large_file_url: Schema.optional(Schema.String),
  preview_file_url: Schema.optional(Schema.String),
  tag_string_character: Schema.String,
  tag_string_copyright: Schema.String,
  tag_string_artist: Schema.String,
  tag_string_general: Schema.String,
});
export type DanbooruPost = typeof DanbooruPostSchema.Type;

export class DanbooruNotFoundError extends Schema.TaggedError<
  DanbooruNotFoundError,
  {
    readonly brand: unique symbol;
  }
>()("DanbooruNotFoundError", { queryTags: Schema.String }) {}

export class DanbooruRateLimitError extends Schema.TaggedError<
  DanbooruRateLimitError,
  {
    readonly brand: unique symbol;
  }
>()("DanbooruRateLimitError", {}) {}

export class DanbooruApiError extends Schema.TaggedError<
  DanbooruApiError,
  {
    readonly brand: unique symbol;
  }
>()("DanbooruApiError", {
  status: Schema.Finite,
  message: Schema.String,
}) {}

const DANBOORU_API_BASE = "https://danbooru.donmai.us/posts/random.json";

export class DanbooruClient extends Context.Service<
  DanbooruClient,
  {
    readonly getRandomPost: (
      tags?: readonly string[],
    ) => Effect.Effect<
      DanbooruPost,
      DanbooruNotFoundError | DanbooruRateLimitError | DanbooruApiError
    >;
    readonly downloadImage: (
      url: string,
    ) => Effect.Effect<string, DanbooruApiError>;
  }
>()("sakurako/danbooru/DanbooruClient") {
  static readonly layer = Layer.effect(
    DanbooruClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;

      const getRandomPost = Effect.fnUntraced(function* (
        tags?: readonly string[],
      ): Effect.fn.Return<
        DanbooruPost,
        DanbooruNotFoundError | DanbooruRateLimitError | DanbooruApiError
      > {
        const queryTagsList = ["is:sfw", "is:active"];
        if (tags && tags.length > 0) {
          queryTagsList.push(...tags);
        }
        const queryTags = queryTagsList.join(" ");

        const targetUrl = Url.setUrlParams(new URL(DANBOORU_API_BASE), {
          tags: queryTags,
        }).toString();
        const request = HttpClientRequest.get(targetUrl).pipe(
          HttpClientRequest.setHeader("User-Agent", DANBOORU_USER_AGENT),
        );

        return yield* fetchJson(request, DanbooruPostSchema, {
          timeoutDuration: "10 seconds",
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTags({
            HttpNotFoundError: () => new DanbooruNotFoundError({ queryTags }),
            HttpNoContentError: () => new DanbooruNotFoundError({ queryTags }),
            HttpRateLimitError: () => new DanbooruRateLimitError(),
            HttpTimeoutError: (err) =>
              new DanbooruApiError({ status: 0, message: err.message }),
            HttpNetworkError: (err) =>
              new DanbooruApiError({ status: err.status ?? 0, message: err.message }),
          }),
        );
      });

      const downloadImage = Effect.fnUntraced(function* (
        url: string,
      ): Effect.fn.Return<string, DanbooruApiError> {
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("User-Agent", DANBOORU_USER_AGENT),
        );

        return yield* executeWithResponse(request, (response) =>
          Effect.gen(function* () {
            const buffer = yield* response.arrayBuffer;
            const base64 = Buffer.from(buffer).toString("base64");
            return `base64://${base64}`;
          }),
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError((err) => {
            const status =
              "status" in err && typeof err.status === "number"
                ? err.status
                : 0;
            return new DanbooruApiError({
              status,
              message: err.message,
            });
          }),
        );
      });

      return DanbooruClient.of({
        getRandomPost,
        downloadImage,
      });
    }),
  );
}
