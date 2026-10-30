import { describe, expect, it } from "bun:test";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import {
  formatLogMessagePrefix,
  formatLogSnippet,
} from "../../src/utils/LogFormat.ts";

describe("LogFormat", () => {
  it("formats message prefix with message_id and user_id", () => {
    const mockEvent = {
      message_id: 123456,
      user_id: 10001,
      message_type: "group",
      group_id: 20002,
    } as unknown as OneBotMessageEvent;

    expect(formatLogMessagePrefix(mockEvent)).toBe("[msg:123456] [user:10001]");
  });

  it("handles negative message IDs in prefix", () => {
    const mockEvent = {
      message_id: -987654,
      user_id: 10001,
    } as unknown as OneBotMessageEvent;

    expect(formatLogMessagePrefix(mockEvent)).toBe(
      "[msg:-987654] [user:10001]",
    );
  });
  it("falls back gracefully when message_id or user_id are missing", () => {
    const mockEvent = {} as unknown as OneBotMessageEvent;
    expect(formatLogMessagePrefix(mockEvent)).toBe(
      "[msg:unknown] [user:unknown]",
    );
  });

  it("formats log snippet by collapsing newlines and truncating width", () => {
    expect(formatLogSnippet("hello\nworld\r\nfoo", 20)).toBe("hello world foo");
    expect(
      formatLogSnippet("这是一段非常非常长的测试文本用于验证日志截断效果", 10),
    ).toBe("这是一...");
    expect(formatLogSnippet(undefined)).toBe("");
    expect(formatLogSnippet("")).toBe("");
    expect(formatLogSnippet(["array", "message"])).toBe("");
    expect(formatLogSnippet(12345)).toBe("");
  });
});
