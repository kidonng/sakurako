import { describe, expect, it } from "bun:test";
import {
  classifyMessage,
  getShanghaiDateString,
  isGroupPokeNotice,
  isGroupReactionNotice,
} from "../../../src/features/stats/StatsClassifier.ts";

describe("StatsClassifier", () => {
  describe("classifyMessage", () => {
    it("classifies plain text message", () => {
      const res = classifyMessage([
        { type: "text", data: { text: "hello world" } },
      ], "hello world");
      expect(res).toEqual({ hasMedia: false, hasLink: false });
    });

    it("classifies image message as media", () => {
      const res = classifyMessage([
        { type: "image", data: { file: "abc.jpg" } },
      ], "[CQ:image,file=abc.jpg]");
      expect(res).toEqual({ hasMedia: true, hasLink: false });
    });

    it("classifies record voice message as media", () => {
      const res = classifyMessage([
        { type: "record", data: { file: "abc.amr" } },
      ]);
      expect(res).toEqual({ hasMedia: true, hasLink: false });
    });

    it("classifies video message as media", () => {
      const res = classifyMessage([
        { type: "video", data: { file: "abc.mp4" } },
      ]);
      expect(res).toEqual({ hasMedia: true, hasLink: false });
    });

    it("classifies text with URL as link", () => {
      const res = classifyMessage(
        [{ type: "text", data: { text: "check https://github.com" } }],
        "check https://github.com",
      );
      expect(res).toEqual({ hasMedia: false, hasLink: true });
    });

    it("classifies combined media + link message (Review Focus 1)", () => {
      const res = classifyMessage(
        [
          { type: "text", data: { text: "see https://example.com/item" } },
          { type: "image", data: { file: "preview.png" } },
        ],
        "see https://example.com/item [CQ:image,file=preview.png]",
      );
      expect(res).toEqual({ hasMedia: true, hasLink: true });
    });

    it("detects media in raw CQ string when segment array is string or empty", () => {
      const res = classifyMessage(
        "[CQ:image,file=test.png]",
        "[CQ:image,file=test.png]",
      );
      expect(res).toEqual({ hasMedia: true, hasLink: false });
    });
  });

  describe("isGroupPokeNotice", () => {
    it("identifies valid group poke notice", () => {
      const event = {
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        group_id: 10001,
        user_id: 20001,
        target_id: 30001,
      };
      expect(isGroupPokeNotice(event)).toBe(true);
    });

    it("rejects poke notice without group_id", () => {
      const event = {
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        user_id: 20001,
      };
      expect(isGroupPokeNotice(event)).toBe(false);
    });

    it("rejects non-poke notify notice", () => {
      const event = {
        post_type: "notice",
        notice_type: "notify",
        sub_type: "honor",
        group_id: 10001,
        user_id: 20001,
      };
      expect(isGroupPokeNotice(event)).toBe(false);
    });
  });

  describe("isGroupReactionNotice", () => {
    it("identifies reaction addition", () => {
      const event = {
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "add",
        group_id: 10001,
        user_id: 20001,
        operator_id: 20001,
      };
      expect(isGroupReactionNotice(event)).toBe(true);
    });

    it("identifies reaction removal (Review Focus 2)", () => {
      const event = {
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "remove",
        group_id: 10001,
        user_id: 20001,
      };
      expect(isGroupReactionNotice(event)).toBe(true);
      expect(event.sub_type).toBe("remove");
    });

    it("rejects reaction notice without group_id", () => {
      const event = {
        post_type: "notice",
        notice_type: "group_msg_emoji_like",
        sub_type: "add",
        user_id: 20001,
      };
      expect(isGroupReactionNotice(event)).toBe(false);
    });
  });

  describe("getShanghaiDateString", () => {
    it("returns correct YYYY-MM-DD formatted string in Asia/Shanghai timezone", () => {
      // 2026-11-02 18:30:00 UTC is 2026-11-03 02:30:00 Asia/Shanghai
      const date = new Date("2026-11-02T18:30:00.000Z");
      expect(getShanghaiDateString(date)).toBe("2026-11-03");
    });

    it("returns correct date for noon UTC", () => {
      // 2026-11-02 04:00:00 UTC is 2026-11-02 12:00:00 Asia/Shanghai
      const date = new Date("2026-11-02T04:00:00.000Z");
      expect(getShanghaiDateString(date)).toBe("2026-11-02");
    });
  });
});
