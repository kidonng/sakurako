/* oxlint-disable effecttsgo/unstable-api-usage */
import { Cause, Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const DEFAULT_USER_AGENT = "Sakurako/1.0";
export const DANBOORU_USER_AGENT = "Sakurako/1.0 (user #898759)";

export class HttpNotFoundError extends Schema.TaggedError<
  HttpNotFoundError,
  {
    readonly brand: unique symbol;
  }
>()("HttpNotFoundError", {
  url: Schema.String,
  status: Schema.Literal(404),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 404${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpNoContentError extends Schema.TaggedError<
  HttpNoContentError,
  {
    readonly brand: unique symbol;
  }
>()("HttpNoContentError", {
  url: Schema.String,
  status: Schema.Literal(204),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 204${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpRateLimitError extends Schema.TaggedError<
  HttpRateLimitError,
  {
    readonly brand: unique symbol;
  }
>()("HttpRateLimitError", {
  url: Schema.String,
  status: Schema.Literal(429),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP 429${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpClientStatusError extends Schema.TaggedError<
  HttpClientStatusError,
  {
    readonly brand: unique symbol;
  }
>()("HttpClientStatusError", {
  url: Schema.String,
  status: Schema.Finite,
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpServerStatusError extends Schema.TaggedError<
  HttpServerStatusError,
  {
    readonly brand: unique symbol;
  }
>()("HttpServerStatusError", {
  url: Schema.String,
  status: Schema.Finite,
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
  }
}

export class HttpTimeoutError extends Schema.TaggedError<
  HttpTimeoutError,
  {
    readonly brand: unique symbol;
  }
>()("HttpTimeoutError", {
  url: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class HttpNetworkError extends Schema.TaggedError<
  HttpNetworkError,
  {
    readonly brand: unique symbol;
  }
>()("HttpNetworkError", {
  url: Schema.String,
  status: Schema.optional(Schema.Finite),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export type HttpFetchError =
  | HttpNotFoundError
  | HttpNoContentError
  | HttpRateLimitError
  | HttpClientStatusError
  | HttpServerStatusError
  | HttpTimeoutError
  | HttpNetworkError;

export function cancelResponse(
  response: HttpClientResponse.HttpClientResponse,
): void {
  const webRes = Option.getOrUndefined(HttpClientResponse.toWeb(response));
  if (webRes && !webRes.bodyUsed && webRes.body && !webRes.body.locked) {
    void webRes.body.cancel().catch(() => {});
  }
}

export interface RequestExecutionOptions {
  readonly timeoutDuration?: Duration.Input;
}

export function executeWithResponse<A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  onResponse: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>,
  options?: RequestExecutionOptions,
): Effect.Effect<A, E | HttpFetchError, R | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const timeoutDuration = options?.timeoutDuration ?? "10 seconds";
    const url = request.url || "";

    const finalRequest = request.headers["user-agent"]
      ? request
      : HttpClientRequest.setHeader(request, "User-Agent", DEFAULT_USER_AGENT);

    const run = Effect.gen(function* () {
      const response = yield* client.execute(finalRequest).pipe(
        Effect.mapError(
          (error) =>
            new HttpNetworkError({
              url,
              detail: error.message,
            }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        const webRes = Option.getOrUndefined(
          HttpClientResponse.toWeb(response),
        );
        cancelResponse(response);
        const status = response.status;
        const statusText = webRes?.statusText;
        const detail = `HTTP status ${status}`;

        if (status === 404) {
          return yield* new HttpNotFoundError({
            url,
            status: 404,
            statusText,
            detail,
          });
        }
        if (status === 429) {
          return yield* new HttpRateLimitError({
            url,
            status: 429,
            statusText,
            detail,
          });
        }
        if (status >= 500) {
          return yield* new HttpServerStatusError({
            url,
            status,
            statusText,
            detail,
          });
        }
        return yield* new HttpClientStatusError({
          url,
          status,
          statusText,
          detail,
        });
      }

      return yield* onResponse(response).pipe(
        Effect.onError(() => Effect.sync(() => cancelResponse(response))),
      );
    });

    return yield* run.pipe(
      Effect.timeout(timeoutDuration),
      Effect.mapError((error) => {
        if (Cause.isTimeoutError(error)) {
          const timeoutStr =
            typeof timeoutDuration === "string"
              ? timeoutDuration
              : Option.flatMap(
                  Duration.fromInput(timeoutDuration),
                  Duration.formatIso,
                ).pipe(Option.getOrElse(() => "timeout"));
          return new HttpTimeoutError({
            url,
            detail: `Request timed out after ${timeoutStr}`,
          });
        }
        return error;
      }),
    );
  });
}

export function fetchText(
  request: HttpClientRequest.HttpClientRequest,
  options?: RequestExecutionOptions,
): Effect.Effect<
  { readonly text: string; readonly url: string },
  HttpFetchError,
  HttpClient.HttpClient
> {
  return executeWithResponse(
    request,
    (response) =>
      Effect.gen(function* () {
        const text = yield* response.text.pipe(
          Effect.mapError(
            (error) =>
              new HttpNetworkError({
                url: request.url,
                detail: `Failed to read response text: ${error.message}`,
              }),
          ),
        );
        const url = response.url || request.url;
        return { text, url };
      }),
    options,
  );
}

export function fetchJson<A, I, RD>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.ConstraintCodec<A, I, RD, unknown>,
  options?: RequestExecutionOptions,
): Effect.Effect<A, HttpFetchError, RD | HttpClient.HttpClient> {
  return executeWithResponse(
    request,
    (response) =>
      Effect.gen(function* () {
        if (response.status === 204) {
          cancelResponse(response);
          return yield* new HttpNoContentError({
            url: request.url,
            status: 204,
            statusText: "No Content",
            detail: "HTTP 204 No Content for JSON response",
          });
        }

        return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(
            (error) =>
              new HttpNetworkError({
                url: request.url,
                status: response.status,
                detail: `Failed to parse response JSON: ${String(error)}`,
              }),
          ),
        );
      }),
    options,
  );
}
