import { describe, expect, it } from "bun:test";
import { parseImageGenInput } from "../../../src/features/image-gen/ImageGenParser.ts";

describe("parseImageGenInput", () => {
  it("returns undefined for non-/gen messages", () => {
    expect(parseImageGenInput("")).toBeUndefined();
    expect(parseImageGenInput("/generate cat")).toBeUndefined();
    expect(parseImageGenInput("hello /gen cat")).toBeUndefined();
    expect(parseImageGenInput("/gen16:9 cat")).toBeUndefined();
  });

  it("parses empty /gen and ratio-only /gen as empty prompt", () => {
    expect(parseImageGenInput("/gen")).toEqual({ prompt: "" });
    expect(parseImageGenInput("/gen   ")).toEqual({ prompt: "" });
    expect(parseImageGenInput("/gen\n  ")).toEqual({ prompt: "" });
    expect(parseImageGenInput("/gen 16:9")).toEqual({
      aspectRatio: "16:9",
      prompt: "",
    });
    expect(parseImageGenInput("/gen 16：9  ")).toEqual({
      aspectRatio: "16:9",
      prompt: "",
    });
  });

  it("extracts all supported aspect ratios with half-width or full-width colon", () => {
    for (const ratio of ["1:1", "4:3", "3:4", "16:9", "9:16"] as const) {
      expect(parseImageGenInput(`/gen ${ratio} a cute cat`)).toEqual({
        aspectRatio: ratio,
        prompt: "a cute cat",
      });

      const fullWidth = ratio.replace(":", "：");
      expect(parseImageGenInput(`/gen   ${fullWidth}\n  赛博朋克猫娘  `)).toEqual({
        aspectRatio: ratio,
        prompt: "赛博朋克猫娘",
      });
    }
  });

  it("keeps non-ratio colon tokens, unsupported ratios, and 'auto' in prompt", () => {
    expect(parseImageGenInput("/gen 12:30 的街头")).toEqual({
      prompt: "12:30 的街头",
    });
    expect(parseImageGenInput("/gen 21:9 cinema shot")).toEqual({
      prompt: "21:9 cinema shot",
    });
    expect(parseImageGenInput("/gen auto mobile")).toEqual({
      prompt: "auto mobile",
    });
    expect(parseImageGenInput("/gen   orange cat sitting on windowsill")).toEqual({
      prompt: "orange cat sitting on windowsill",
    });
  });
});
