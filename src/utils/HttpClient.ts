import { Cause, type Duration, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const DEFAULT_USER_AGENT = "Sakurako/1.0";

export class HttpFetchError extends Schema.TaggedError<
  HttpFetchError,
  {
    readonly brand: unique symbol;
  }
>()("HttpFetchError", {
  url: Schema.String,
  status: Schema.optional(Schema.Finite),
  statusText: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const parts: string[] = [];
    if (this.status !== undefined) {
      parts.push(
        `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`,
      );
    }
    if (this.detail) {
      parts.push(this.detail);
    }
    return `Failed to fetch ${this.url}: ${parts.join(" - ") || "Unknown error"}`;
  }
}

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

export const executeWithResponse = Effect.fnUntraced(function* <A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  onResponse: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>,
  options?: RequestExecutionOptions,
): Effect.Effect<A, E | HttpFetchError, R | HttpClient.HttpClient> {
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
          new HttpFetchError({
            url,
            detail: error.message,
          }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      const webRes = Option.getOrUndefined(HttpClientResponse.toWeb(response));
      cancelResponse(response);
      return yield* new HttpFetchError({
        url,
        status: response.status,
        statusText: webRes?.statusText,
        detail: `HTTP status ${response.status}`,
      });
    }

    return yield* onResponse(response).pipe(
      Effect.onError(() => Effect.sync(() => cancelResponse(response))),
    );
  });

  return yield* run.pipe(
    Effect.timeout(timeoutDuration),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error)
        ? new HttpFetchError({
            url,
            detail: `Request timed out after ${String(timeoutDuration)}`,
          })
        : error,
    ),
  );
});
export const fetchText = (
  request: HttpClientRequest.HttpClientRequest,
  options?: RequestExecutionOptions,
): Effect.Effect<
  { readonly text: string; readonly url: string },
  HttpFetchError,
  HttpClient.HttpClient
> =>
  executeWithResponse(
    request,
    (response) =>
      Effect.gen(function* () {
        const text = yield* response.text;
        const url = response.url || request.url;
        return { text, url };
      }),
    options,
  );

export const fetchJson = <A, I, R>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Schema<A, I, R>,
  options?: RequestExecutionOptions,
): Effect.Effect<A, HttpFetchError, R | HttpClient.HttpClient> =>
  executeWithResponse(
    request,
    (response) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (error) =>
            new HttpFetchError({
              url: request.url,
              status: response.status,
              detail: `Failed to parse response JSON: ${error.message}`,
            }),
        ),
      ),
    options,
  );
