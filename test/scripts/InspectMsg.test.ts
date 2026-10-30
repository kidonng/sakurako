import { describe, expect, it } from "bun:test";
import {
  formatMessageReport,
  parseMessageId,
} from "../../scripts/inspect-msg.ts";

describe("InspectMsg CLI helper", () => {
  it("parses positive and negative integer message IDs", () => {
    expect(parseMessageId(["12345"])).toBe(12345);
    expect(parseMessageId(["-12345678"])).toBe(-12345678);
    expect(parseMessageId(["0"])).toBe(0);
  });

  it("returns undefined for missing or invalid argument", () => {
    expect(parseMessageId([])).toBeUndefined();
    expect(parseMessageId(["abc"])).toBeUndefined();
    expect(parseMessageId(["12.34"])).toBeUndefined();
    expect(parseMessageId(["--help"])).toBeUndefined();
  });

  it("formats message report with metadata and content", () => {
    const rawData = {
      message_id: 12345678,
      message_type: "group",
      group_id: 20002,
      group_name: "Mock Group",
      user_id: 10001,
      sender: {
        nickname: "Mock User",
        card: "Admin",
      },
      time: 1700000000,
      raw_message: "这是一条测试消息",
      message: [{ type: "text", data: { text: "这是一条测试消息" } }],
    };
    const report = formatMessageReport(rawData);
    expect(report).toContain("Message ID: 12345678");
    expect(report).toContain("Group: Mock Group (20002)");
    expect(report).toContain("Sender: Admin (10001)");
    expect(report).toContain("这是一条测试消息");
  });
});
