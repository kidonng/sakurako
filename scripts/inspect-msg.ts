import { BunRuntime } from "@effect/platform-bun";
import { createWebSocketClient } from "@snowluma/sdk";
import { DateTime, Effect, Redacted, Schema } from "effect";
import { BotConfig } from "../src/Config.ts";

export class InspectError extends Schema.TaggedError<
  InspectError,
  {
    readonly brand: unique symbol;
  }
>()("InspectError", {
  message: Schema.String,
}) {}

export function parseMessageId(args: readonly string[]): number | undefined {
  if (args.length === 0) return undefined;
  const raw = args[0];
  if (!raw || !/^-?\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface RawMessageData {
  readonly message_id?: number;
  readonly message_type?: string;
  readonly sub_type?: string;
  readonly group_id?: number;
  readonly group_name?: string;
  readonly user_id?: number;
  readonly sender?: {
    readonly nickname?: string;
    readonly card?: string;
    readonly role?: string;
  };
  readonly time?: number;
  readonly raw_message?: string;
  readonly message?: unknown;
}

export function formatMessageReport(data: RawMessageData): string {
  const lines: string[] = [];
  lines.push(`Message ID: ${data.message_id ?? "unknown"}`);
  lines.push(`Type: ${data.message_type ?? "unknown"}`);

  if (data.message_type === "group" && data.group_id !== undefined) {
    const groupName = data.group_name ? `${data.group_name} ` : "";
    lines.push(`Group: ${groupName}(${data.group_id})`);
  }

  const senderName = data.sender?.card || data.sender?.nickname || "unknown";
  const senderId = data.user_id ?? "unknown";
  lines.push(`Sender: ${senderName} (${senderId})`);

  if (data.time) {
    const dateStr = DateTime.formatIso(DateTime.makeUnsafe(data.time * 1000));
    lines.push(`Time: ${dateStr} (${data.time})`);
  }

  lines.push(`Raw Message: ${data.raw_message ?? ""}`);
  return lines.join("\n");
}

export const mainProgram = Effect.fnUntraced(function* (messageId: number) {
  const config = yield* BotConfig;
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createWebSocketClient({
        url: config.wsUrl,
        accessToken: Redacted.value(config.accessToken),
      }),
    ),
    (client) => Effect.sync(() => client.close()),
  );

  yield* Effect.tryPromise({
    try: () => ws.connect(),
    catch: (err) =>
      new InspectError({
        message: `WebSocket connection failed: ${String(err)}`,
      }),
  });

  const response = yield* Effect.tryPromise({
    try: () =>
      ws.request("get_msg", {
        message_id: messageId,
      }),
    catch: (err) =>
      new InspectError({
        message: `Failed to call OneBot get_msg: ${String(err)}`,
      }),
  });

  if (response.status !== "ok" || response.retcode !== 0 || !response.data) {
    return yield* new InspectError({
      message: `OneBot returned error (retcode: ${response.retcode}, wording: ${response.wording ?? "unknown"})`,
    });
  }

  console.log("=== Message Metadata ===");
  console.log(formatMessageReport(response.data as RawMessageData));
  console.log("\n=== Raw JSON Payload ===");
  console.log(JSON.stringify(response.data, null, 2));
});

if (import.meta.main) {
  const messageId = parseMessageId(process.argv.slice(2));
  if (messageId === undefined) {
    console.error("Usage: bun run inspect-msg <message_id>");
    console.error("Example: bun run inspect-msg 12345678");
    process.exit(1);
  }

  // oxlint-disable-next-line effecttsgo/unstable-api-usage
  BunRuntime.runMain(mainProgram(messageId).pipe(Effect.scoped));
}
