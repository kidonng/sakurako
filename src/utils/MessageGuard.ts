import type { OneBotBaseEvent } from "@snowluma/sdk/types";

/**
 * Whether a message event was sent by the bot account itself.
 *
 * OneBot echoes messages sent by the account back through the event stream
 * (`post_type: "message_sent"`), and some backends also deliver self-sent
 * messages as regular `message` events. Replying to either would make the bot
 * answer its own replies in a loop.
 */
export function isSelfMessage(event: OneBotBaseEvent & { readonly user_id?: number }): boolean {
  if (event.post_type === "message_sent") {
    return true;
  }
  return event.user_id !== undefined && event.user_id === event.self_id;
}
