import { describe, expect, it } from "bun:test";
import {
  extractUserImageFiles,
  sanitizeUserMessageForDecision,
} from "../../../src/features/link-preview/LinkPreview.ts";

describe("LinkPreview Sanitizer & Image Extractor", () => {
  it("sanitizes CQ image and at codes into human placeholders", () => {
    const raw =
      "check this out https://example.com [CQ:image,file=abc.png,url=https://img.qq.com/abc] [CQ:at,qq=123456]";
    const sanitized = sanitizeUserMessageForDecision(raw);
    expect(sanitized).toBe("check this out https://example.com [图片] @用户");
  });

  it("extracts target strings defaulting to at most 1 item", () => {
    const raw =
      "https://example.com [CQ:image,file=1.png,url=https://img.com/1.png] [CQ:image,file=2.png]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toEqual(["https://img.com/1.png"]);
  });
});
