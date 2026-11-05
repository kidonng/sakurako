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

/**
 * Options for environment-based event filtering.
 */
export interface EventFilterOptions {
  readonly devMode: boolean;
  readonly devGroupId?: number;
}

/**
 * Determines whether an incoming OneBot event should be processed given the
 * current environment configuration.
 *
 * - In development mode (`devMode: true`):
 *   Only events originating from the configured `devGroupId` are processed.
 *   Private messages and events from all other groups are ignored.
 *
 * - In production mode (`devMode: false`):
 *   Events from the configured `devGroupId` are ignored so they can be
 *   exclusively handled by a local development instance. All other groups and
 *   private messages are processed normally.
 */
export function shouldProcessEvent(
  event: OneBotBaseEvent & { readonly group_id?: unknown },
  options: EventFilterOptions,
): boolean {
  if (options.devMode) {
    return (
      options.devGroupId !== undefined && event.group_id === options.devGroupId
    );
  }

  return (
    options.devGroupId === undefined || event.group_id !== options.devGroupId
  );
}
