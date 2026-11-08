import { describe, expect, it } from "bun:test";
import {
  extractMessageImages,
  parseCommand,
  parseMessageSegments,
} from "../../src/utils/Command.ts";

describe("Command utils", () => {
  describe("parseMessageSegments", () => {
    it("returns array segments when message is already an array", () => {
      const segments = [
        { type: "text", data: { text: "hello" } },
        { type: "face", data: { id: "1" } },
      ];
      expect(parseMessageSegments(segments)).toEqual(segments);
    });

    it("parses raw_message CQ string when message is not an array", () => {
      const segments = parseMessageSegments(undefined, "[CQ:face,id=14] test");
      expect(segments).toEqual([
        { type: "face", data: { id: "14" } },
        { type: "text", data: { text: " test" } },
      ]);
    });

    it("parses message as CQ string if raw_message is absent", () => {
      const segments = parseMessageSegments("[CQ:face,id=14] test");
      expect(segments).toEqual([
        { type: "face", data: { id: "14" } },
        { type: "text", data: { text: " test" } },
      ]);
    });

    it("falls back to raw_message when message is an empty array", () => {
      const segments = parseMessageSegments([], "[CQ:face,id=14] test");
      expect(segments).toEqual([
        { type: "face", data: { id: "14" } },
        { type: "text", data: { text: " test" } },
      ]);
    });

    it("returns empty array when neither message nor raw_message is valid", () => {
      expect(parseMessageSegments(null, undefined)).toEqual([]);
      expect(parseMessageSegments(123, null)).toEqual([]);
    });
  });

  describe("parseCommand", () => {
    it("parses a simple text command", () => {
      const result = parseCommand({
        message: [{ type: "text", data: { text: "  /sauce  " } }],
      });
      expect(result).toBeDefined();
      expect(result?.text).toBe("/sauce");
      expect(result?.replyMessageId).toBeUndefined();
    });

    it("concatenates multiple text segments and trims whitespace", () => {
      const result = parseCommand({
        message: [
          { type: "text", data: { text: " /stat " } },
          { type: "text", data: { text: " all " } },
        ],
      });
      expect(result?.text).toBe("/stat  all");
    });

    it("strips reply and at segments from command text", () => {
      const result = parseCommand({
        message: [
          { type: "reply", data: { id: "12345" } },
          { type: "at", data: { qq: "99999" } },
          { type: "text", data: { text: " /sauce " } },
          { type: "at", data: { qq: "10001" } },
        ],
      });
      expect(result?.text).toBe("/sauce");
      expect(result?.replyMessageId).toBe(12345);
    });

    it("supports negative integer reply message IDs", () => {
      const result = parseCommand({
        message: [
          { type: "reply", data: { id: "-1946661968" } },
          { type: "text", data: { text: "/sauce" } },
        ],
      });
      expect(result?.replyMessageId).toBe(-1946661968);
    });

    it("ignores replyMessageId if id is 0 or non-integer", () => {
      const resultZero = parseCommand({
        message: [
          { type: "reply", data: { id: "0" } },
          { type: "text", data: { text: "/sauce" } },
        ],
      });
      expect(resultZero?.replyMessageId).toBeUndefined();

      const resultInvalid = parseCommand({
        message: [
          { type: "reply", data: { id: "abc" } },
          { type: "text", data: { text: "/sauce" } },
        ],
      });
      expect(resultInvalid?.replyMessageId).toBeUndefined();
    });

    it("returns undefined if there are non-text segments other than reply and at", () => {
      const resultWithImage = parseCommand({
        message: [
          { type: "text", data: { text: "/sauce" } },
          { type: "image", data: { file: "test.jpg" } },
        ],
      });
      expect(resultWithImage).toBeUndefined();

      const resultWithFace = parseCommand({
        raw_message: "[CQ:face,id=1] /sauce",
      });
      expect(resultWithFace).toBeUndefined();
    });

    it("parses command from raw_message string", () => {
      const result = parseCommand({
        raw_message: "[CQ:reply,id=54321][CQ:at,qq=123] /stat all",
      });
      expect(result?.text).toBe("/stat all");
      expect(result?.replyMessageId).toBe(54321);
    });
  });
  describe("extractMessageImages", () => {
    it("extracts images with file and url from structured segments", () => {
      const segments = [
        { type: "text", data: { text: "hello" } },
        {
          type: "image",
          data: { file: "test.png", url: "https://example.com/test.png" },
        },
      ];
      const result = extractMessageImages(segments);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        file: "test.png",
        url: "https://example.com/test.png",
        target: "https://example.com/test.png",
      });
    });

    it("extracts image from CQ string with file and url", () => {
      const raw =
        "test [CQ:image,file=abc.png,url=https://multimedia.nt.qq.com/img1]";
      const result = extractMessageImages(undefined, raw);
      expect(result).toEqual([
        {
          file: "abc.png",
          url: "https://multimedia.nt.qq.com/img1",
          target: "https://multimedia.nt.qq.com/img1",
        },
      ]);
    });

    it("falls back to file when url is missing", () => {
      const raw = "[CQ:image,file=only-file.png]";
      const result = extractMessageImages(undefined, raw);
      expect(result).toEqual([
        {
          file: "only-file.png",
          url: undefined,
          target: "only-file.png",
        },
      ]);
    });

    it("respects limit parameter", () => {
      const raw = "[CQ:image,file=1.png] [CQ:image,file=2.png]";
      const result = extractMessageImages(undefined, raw, 1);
      expect(result).toHaveLength(1);
      expect(result[0]?.file).toBe("1.png");
    });
  });
});
