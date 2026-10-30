import {
  SnowLumaWebSocketClient,
  type SnowLumaEventContextWithQuote,
} from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import {
  Context,
  Effect,
  Layer,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { BotConfig } from "./Config.ts";

export interface IncomingMessage {
  readonly event: OneBotMessageEvent;
  readonly context: SnowLumaEventContextWithQuote<OneBotMessageEvent>;
}

export class WebSocketConnectionError extends Schema.TaggedError<
  WebSocketConnectionError,
  {
    readonly brand: unique symbol;
  }
>()("WebSocketConnectionError", {
  message: Schema.String,
}) {}

export class SnowLumaClient extends Context.Service<
  SnowLumaClient,
  {
    readonly client: SnowLumaWebSocketClient;
    readonly messages: Stream.Stream<IncomingMessage>;
  }
>()("sakurako/SnowLumaClient") {
  static readonly layer = Layer.effect(
    SnowLumaClient,
    Effect.gen(function* () {
      const config = yield* BotConfig;
      const queue = yield* Queue.unbounded<IncomingMessage>();

      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const ws = new SnowLumaWebSocketClient({
            url: config.wsUrl,
            accessToken: Redacted.value(config.accessToken),
            reconnect: true,
          });
          ws.onMessage((event, eventContext) => {
            Queue.offerUnsafe(queue, { event, context: eventContext });
          });
          return ws;
        }),
        (ws) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("Closing SnowLuma WebSocket client...");
            ws.close();
            yield* Queue.shutdown(queue);
          }),
      );

      yield* Effect.logInfo(
        `Connecting to SnowLuma WebSocket at ${config.wsUrl}...`,
      );
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (error) =>
          new WebSocketConnectionError({ message: String(error) }),
      }).pipe(
        Effect.retry(
          Schedule.exponential("500 millis").pipe(
            Schedule.upTo({ duration: "10 seconds" }),
          ),
        ),
      );
      yield* Effect.logInfo("Connected to SnowLuma WebSocket");

      return SnowLumaClient.of({
        client,
        messages: Stream.fromQueue(queue),
      });
    }),
  );
}
