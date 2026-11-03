/* oxlint-disable effecttsgo/unstable-api-usage */
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  Url,
} from "effect/http";
import { executeWithResponse, HttpFetchError } from "../../utils/HttpClient.ts";
import { DANBOORU_USER_AGENT } from "../link-preview/LinkPreviewSites.ts";

const DanbooruPostSchema = Schema.Struct({
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

        return yield* executeWithResponse(
          request,
          (response) =>
            Effect.gen(function* () {
              if (response.status === 204) {
                return yield* new DanbooruNotFoundError({ queryTags });
              }
              const post = yield* HttpClientResponse.schemaBodyJson(
                DanbooruPostSchema,
              )(response).pipe(
                Effect.mapError(
                  (err) =>
                    new HttpFetchError({
                      url: request.url,
                      status: response.status,
                      detail: `Failed to decode Danbooru post JSON: ${String(err)}`,
                    }),
                ),
              );
              return post;
            }),
          { timeoutDuration: "10 seconds" },
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError((error) => {
            if (error._tag === "HttpFetchError") {
              if (error.status === 404) {
                return new DanbooruNotFoundError({ queryTags });
              }
              if (error.status === 429) {
                return new DanbooruRateLimitError();
              }
              return new DanbooruApiError({
                status: error.status ?? 0,
                message: error.message,
              });
            }
            return error;
          }),
        );
      });

      const downloadImage = Effect.fnUntraced(function* (
        url: string,
      ): Effect.fn.Return<string, DanbooruApiError> {
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("User-Agent", DANBOORU_USER_AGENT),
        );

        return yield* executeWithResponse(
          request,
          (response) =>
            Effect.gen(function* () {
              const buffer = yield* response.arrayBuffer;
              const base64 = Buffer.from(buffer).toString("base64");
              return `base64://${base64}`;
            }),
          { timeoutDuration: "20 seconds" },
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
