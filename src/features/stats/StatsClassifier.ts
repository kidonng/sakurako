const MEDIA_SEGMENT_TYPES: Record<string, true> = {
  image: true,
  record: true,
  video: true,
  mface: true,
};

const CQ_MEDIA_REGEX = /\[CQ:(image|record|video|mface),/i;
const HTTP_URL_REGEX = /https?:\/\/[^\s]+/i;

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
        typeof segment === "object" &&
        segment !== null &&
        "type" in segment &&
        typeof segment.type === "string"
      ) {
        if (segment.type in MEDIA_SEGMENT_TYPES) {
          hasMedia = true;
        }
        if (
          segment.type === "text" &&
          "data" in segment &&
          typeof segment.data === "object" &&
          segment.data !== null &&
          "text" in segment.data &&
          typeof segment.data.text === "string" &&
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

export function isGroupPokeNotice(event: unknown): event is {
  readonly post_type: "notice";
  readonly notice_type: "notify";
  readonly sub_type: "poke";
  readonly group_id: number;
  readonly user_id: number;
} {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const e = event as Record<string, unknown>;
  return (
    e.post_type === "notice" &&
    e.notice_type === "notify" &&
    e.sub_type === "poke" &&
    typeof e.group_id === "number" &&
    typeof e.user_id === "number"
  );
}

export function isGroupReactionNotice(event: unknown): event is {
  readonly post_type: "notice";
  readonly notice_type: "group_msg_emoji_like";
  readonly sub_type: "add" | "remove";
  readonly group_id: number;
  readonly user_id?: number;
  readonly operator_id?: number;
} {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const e = event as Record<string, unknown>;
  const userId = typeof e.user_id === "number" ? e.user_id : e.operator_id;
  return (
    e.post_type === "notice" &&
    e.notice_type === "group_msg_emoji_like" &&
    (e.sub_type === "add" || e.sub_type === "remove") &&
    typeof e.group_id === "number" &&
    typeof userId === "number"
  );
}

export function getNoticeOperatorId(event: {
  readonly user_id?: number;
  readonly operator_id?: number;
}): number | undefined {
  return typeof event.user_id === "number" ? event.user_id : event.operator_id;
}
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getShanghaiDateString(date: Date = new Date()): string {
  return SHANGHAI_DATE_FORMATTER.format(date);
}
