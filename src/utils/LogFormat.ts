import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { Predicate } from "effect";
import { truncate } from "./TextWidth.ts";
export function formatLogMessagePrefix(event: OneBotMessageEvent): string {
  const msgId = event.message_id !== undefined ? event.message_id : "unknown";
  const userId = event.user_id !== undefined ? event.user_id : "unknown";
  return `[msg:${msgId}] [user:${userId}]`;
}

export function formatLogSnippet(text: unknown, maxWidth = 30): string {
  if (!Predicate.isString(text) || !text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncate(collapsed, maxWidth);
}
