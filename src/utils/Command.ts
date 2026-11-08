import { parseSegments } from "@snowluma/sdk/messages";
import type { AnyMessageSegment } from "@snowluma/sdk/types";
import { Predicate } from "effect";

export interface ParsedCommand {
  readonly text: string;
  readonly replyMessageId?: number;
  readonly segments: readonly AnyMessageSegment[];
}

/**
 * Normalizes message segments from either a structured segment array or a CQ-code raw string.
 */
export function parseMessageSegments(
  message: unknown,
  rawMessage?: unknown,
): AnyMessageSegment[] {
  if (Array.isArray(message) && message.length > 0) {
    return message as unknown as AnyMessageSegment[];
  }
  if (Predicate.isString(rawMessage) && rawMessage.length > 0) {
    return parseSegments(rawMessage);
  }
  if (Predicate.isString(message) && message.length > 0) {
    return parseSegments(message);
  }
  return [];
}

export interface ExtractedMessageImage {
  readonly file?: string;
  readonly url?: string;
  readonly target: string;
}

/**
 * Extracts image targets and URLs from message segments or CQ string.
 */
export function extractMessageImages(
  message: unknown,
  rawMessage?: unknown,
  limit?: number,
): ReadonlyArray<ExtractedMessageImage> {
  const segments = parseMessageSegments(message, rawMessage);
  const results: ExtractedMessageImage[] = [];
  for (const segment of segments) {
    if (segment.type === "image" && segment.data) {
      const data = segment.data as { file?: unknown; url?: unknown };
      const file =
        Predicate.isString(data.file) && data.file.length > 0
          ? data.file
          : undefined;
      const url =
        Predicate.isString(data.url) && data.url.length > 0
          ? data.url
          : undefined;
      const target = url ?? file;
      if (target) {
        results.push({ file, url, target });
        if (limit !== undefined && results.length >= limit) {
          break;
        }
      }
    }
  }
  return results;
}

/**
 * Parses a message event into a clean command representation:
 * - Strips `reply` and `at` segments.
 * - Rejects messages containing any remaining non-text segments (returns `undefined`).
 * - Concatenates and trims text segments into `text`.
 * - Extracts `replyMessageId` if a valid non-zero integer reply ID is present.
 */
export function parseCommand(event: {
  readonly message?: unknown;
  readonly raw_message?: unknown;
}): ParsedCommand | undefined {
  const rawSegments = parseMessageSegments(event.message, event.raw_message);

  const nonReplyAt = rawSegments.filter(
    (s) => s.type !== "reply" && s.type !== "at",
  );

  const hasNonText = nonReplyAt.some((s) => s.type !== "text");
  if (hasNonText) {
    return undefined;
  }

  const text = nonReplyAt
    .map((s) => {
      const data = s.data as { text?: unknown } | undefined;
      return Predicate.isString(data?.text) ? data.text : "";
    })
    .join("")
    .trim();

  const replySegment = rawSegments.find((s) => s.type === "reply");
  const replyData = replySegment?.data as { id?: unknown } | undefined;
  const replyIdNum = Number(replyData?.id);
  const replyMessageId =
    replySegment &&
    replyData?.id !== undefined &&
    Number.isInteger(replyIdNum) &&
    replyIdNum !== 0
      ? replyIdNum
      : undefined;

  return {
    text,
    replyMessageId,
    segments: rawSegments,
  };
}
