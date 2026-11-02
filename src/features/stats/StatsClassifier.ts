import { DateTime, Predicate, Schema } from "effect";

const MEDIA_SEGMENT_TYPES: Record<string, true> = {
  image: true,
  record: true,
  video: true,
  mface: true,
};

const CQ_MEDIA_REGEX = /\[CQ:(image|record|video|mface),/i;
const HTTP_URL_REGEX = /https?:\/\/\S+/i;

export interface MessageClassification {
  readonly hasMedia: boolean;
  readonly hasLink: boolean;
}

export function classifyMessage(
  message: unknown,
  rawMessage?: string,
): MessageClassification {
  let hasMedia = false;
  let hasLink = false;

  if (Array.isArray(message)) {
    for (const segment of message) {
      if (
        Predicate.isObject(segment) &&
        "type" in segment &&
        Predicate.isString(segment.type)
      ) {
        if (segment.type in MEDIA_SEGMENT_TYPES) {
          hasMedia = true;
        }
        if (
          segment.type === "text" &&
          "data" in segment &&
          Predicate.isObject(segment.data) &&
          "text" in segment.data &&
          Predicate.isString(segment.data.text) &&
          HTTP_URL_REGEX.test(segment.data.text)
        ) {
          hasLink = true;
        }
      }
    }
  }

  if (rawMessage) {
    if (!hasMedia && CQ_MEDIA_REGEX.test(rawMessage)) {
      hasMedia = true;
    }
    if (!hasLink && HTTP_URL_REGEX.test(rawMessage)) {
      hasLink = true;
    }
  }

  return { hasMedia, hasLink };
}

const GroupPokeNotice = Schema.Struct({
  post_type: Schema.Literal("notice"),
  notice_type: Schema.Literal("notify"),
  sub_type: Schema.Literal("poke"),
  group_id: Schema.Finite,
  user_id: Schema.Finite,
});
export const isGroupPokeNotice = Schema.is(GroupPokeNotice);

const GroupReactionNotice = Schema.Struct({
  post_type: Schema.Literal("notice"),
  notice_type: Schema.Literal("group_msg_emoji_like"),
  sub_type: Schema.Literals(["add", "remove"]),
  group_id: Schema.Finite,
  user_id: Schema.optional(Schema.Finite),
  operator_id: Schema.optional(Schema.Finite),
}).pipe(
  Schema.refine(
    (
      e,
    ): e is typeof e &
      ({ readonly user_id: number } | { readonly operator_id: number }) =>
      typeof e.user_id === "number" || typeof e.operator_id === "number",
  ),
);
export const isGroupReactionNotice = Schema.is(GroupReactionNotice);

export function getNoticeOperatorId(event: {
  readonly user_id?: number;
  readonly operator_id?: number;
}): number | undefined {
  return typeof event.user_id === "number" ? event.user_id : event.operator_id;
}
export function getShanghaiDateString(
  input?: DateTime.DateTime | Date,
): string {
  const dt =
    input instanceof Date
      ? DateTime.fromDateUnsafe(input)
      : (input ?? DateTime.nowUnsafe());
  const zoned = DateTime.setZoneNamedUnsafe(dt, "Asia/Shanghai");
  return DateTime.formatIsoDate(zoned);
}

export function getDaysAgoShanghaiDateString(
  days: number,
  input?: DateTime.DateTime | Date,
): string {
  const dt =
    input instanceof Date
      ? DateTime.fromDateUnsafe(input)
      : (input ?? DateTime.nowUnsafe());
  const zoned = DateTime.setZoneNamedUnsafe(dt, "Asia/Shanghai");
  return DateTime.formatIsoDate(DateTime.subtract(zoned, { days }));
}
