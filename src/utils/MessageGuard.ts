import type {
  OneBotBaseEvent,
  OneBotGroupMessageEvent,
} from "@snowluma/sdk/types";
import { Predicate } from "effect";

/**
 * Whether a message event was sent by the bot account itself.
 *
 * OneBot echoes messages sent by the account back through the event stream
 * (`post_type: "message_sent"`), and some backends also deliver self-sent
 * messages as regular `message` events. Replying to either would make the bot
 * answer its own replies in a loop.
 */
export function isSelfMessage(
  event: OneBotBaseEvent & { readonly user_id?: number },
): boolean {
  if (event.post_type === "message_sent") {
    return true;
  }
  return event.user_id !== undefined && event.user_id === event.self_id;
}

/**
 * Whether a message event is from a group chat and has valid group and user IDs.
 */
export function isGroupMessage(
  event: OneBotBaseEvent & {
    readonly message_type?: string;
    readonly group_id?: unknown;
    readonly user_id?: unknown;
  },
): event is OneBotGroupMessageEvent {
  return (
    event.message_type === "group" &&
    Predicate.isNumber(event.group_id) &&
    Predicate.isNumber(event.user_id)
  );
}
