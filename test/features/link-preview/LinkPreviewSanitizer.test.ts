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

  it("extracts valid image target from structured segments or raw message", () => {
    const raw =
      "https://example.com [CQ:image,file=902FE53EC53AE6E3DFD7C0C6EA11FC96.png,url=https://multimedia.nt.qq.com/img1]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toEqual(["https://multimedia.nt.qq.com/img1"]);
  });

  it("falls back to file identifier when url is absent", () => {
    const raw =
      "https://example.com [CQ:image,file=902FE53EC53AE6E3DFD7C0C6EA11FC96.png]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toEqual(["902FE53EC53AE6E3DFD7C0C6EA11FC96.png"]);
  });

  it("limits extracted user image files to at most 1 item", () => {
    const raw = "[CQ:image,file=1.png] [CQ:image,file=2.png]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("1.png");
  });
});
