import {
  SnowLumaWebSocketClient,
  type SnowLumaEventContextWithQuote,
} from "@snowluma/sdk";
import type {
  OneBotMessageEvent,
  OneBotNoticeEvent,
} from "@snowluma/sdk/types";
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
export interface IncomingNotice {
  readonly event: OneBotNoticeEvent;
  readonly context: SnowLumaEventContextWithQuote<OneBotNoticeEvent>;
}

class WebSocketConnectionError extends Schema.TaggedError<
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
    readonly notices: Stream.Stream<IncomingNotice>;
  }
>()("sakurako/SnowLumaClient") {
  static readonly layer = Layer.effect(
    SnowLumaClient,
    Effect.gen(function* () {
      const config = yield* BotConfig;
      const messageQueue = yield* Queue.unbounded<IncomingMessage>();
      const noticeQueue = yield* Queue.unbounded<IncomingNotice>();

      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const ws = new SnowLumaWebSocketClient({
            url: config.wsUrl,
            accessToken: Redacted.value(config.accessToken),
            reconnect: true,
          });
          ws.onMessage((event, eventContext) => {
            Queue.offerUnsafe(messageQueue, { event, context: eventContext });
          });
          ws.onNotice((event, eventContext) => {
            Queue.offerUnsafe(noticeQueue, { event, context: eventContext });
          });
          return ws;
        }),
        (ws) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("Closing SnowLuma WebSocket client...");
            ws.close();
            yield* Queue.shutdown(messageQueue);
            yield* Queue.shutdown(noticeQueue);
          }),
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
      yield* Effect.logInfo(
        `Connected to SnowLuma WebSocket at ${config.wsUrl}`,
      );

      return SnowLumaClient.of({
        client,
        messages: Stream.fromQueue(messageQueue),
        notices: Stream.fromQueue(noticeQueue),
      });
    }),
  );
}
