import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import type { IncomingMessage } from "../src/SnowLuma.ts";

export interface MockMessageOptions {
  readonly raw_message?: string;
  readonly message?: unknown;
  readonly message_type?: "group" | "private";
  readonly post_type?: "message" | "message_sent";
  readonly user_id?: number;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly message_id?: number;
  readonly sender?: {
    readonly user_id?: number;
    readonly nickname?: string;
    readonly card?: string;
    readonly role?: string;
  };
  readonly onReply?: (msg: unknown) => unknown;
  readonly replyError?: Error;
  readonly getMessageResponse?: unknown;
  readonly getMessageError?: boolean;
  readonly onGetMessage?: (id: number) => void;
  readonly client?: Record<string, unknown>;
}

export interface MockMessageHandle {
  readonly item: IncomingMessage;
  readonly getReplies: () => unknown[];
  readonly lastReply: () => unknown;
}

export function createMockMessage(
  params: MockMessageOptions = {},
): MockMessageHandle {
  const sentReplies: unknown[] = [];
  const rawMessage = params.raw_message ?? "";
  const userId = params.user_id ?? 10001;

  const client: Record<string, unknown> = { ...params.client };
  if (
    params.getMessageResponse !== undefined ||
    params.getMessageError ||
    params.onGetMessage
  ) {
    client.getMessage = async (id: number) => {
      params.onGetMessage?.(id);
      if (params.getMessageError) {
        throw new Error("OneBot get_msg error");
      }
      return (params.getMessageResponse ?? {
        message: [],
      }) as Record<string, unknown>;
    };
  }

  const replyFn = async (msg: unknown) => {
    sentReplies.push(msg);
    if (params.replyError) {
      throw params.replyError;
    }
    if (params.onReply) {
      return await params.onReply(msg);
    }
    return Promise.resolve({} as never);
  };

  const item: IncomingMessage = {
    event: {
      time: 1700000000,
      post_type: params.post_type ?? "message",
      message_type: params.message_type ?? "group",
      sub_type: "normal",
      message_id: params.message_id ?? 101,
      group_id: params.group_id ?? 10001,
      user_id: userId,
      self_id: params.self_id ?? 99999,
      raw_message: rawMessage,
      message: params.message ?? rawMessage,
      font: 0,
      sender: params.sender ?? {
        user_id: userId,
        nickname: "MockUser",
      },
    } as unknown as OneBotMessageEvent,
    context: {
      client,
      reply: replyFn,
      quote: replyFn,
    } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
  };

  return {
    item,
    getReplies: () => sentReplies,
    lastReply: () => sentReplies[sentReplies.length - 1],
  };
}
