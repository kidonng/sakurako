/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export function makeTestHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Response | Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.tryPromise({
        try: async () => {
          const webResponse = await handler(request);
          return HttpClientResponse.fromWeb(request, webResponse);
        },
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause,
              description: String(cause),
            }),
          }),
      }),
    ),
  );
}
