import { describe, expect, it } from "bun:test";
import stringWidth from "string-width";
import { truncate } from "../src/TextWidth.ts";

describe("truncate", () => {
  it("returns original text if width <= maxWidth", () => {
    expect(truncate("hello", 100)).toBe("hello");
    expect(truncate("短文本", 100)).toBe("短文本");
  });

  it("truncates long ASCII text to <= maxWidth with ellipsis", () => {
    const text = "a".repeat(120);
    const result = truncate(text, 100);
    expect(stringWidth(result)).toBeLessThanOrEqual(100);
    expect(result.endsWith("...")).toBe(true);
    expect(result).toBe("a".repeat(97) + "...");
  });

  it("truncates long CJK text to <= maxWidth with ellipsis", () => {
    const text = "中".repeat(60); // 120 width
    const result = truncate(text, 100);
    expect(stringWidth(result)).toBeLessThanOrEqual(100);
    expect(result.endsWith("...")).toBe(true);
    // 97 max content width: 48 CJK chars = 96 width, + "..." (3 width) = 99 <= 100
    expect(result).toBe("中".repeat(48) + "...");
  });

  it("handles boundary wide character without exceeding maxWidth", () => {
    // 96 ASCII chars (width 96) + 1 CJK char (width 2) = 98 width
    // With 3-char ellipsis (width 3), 96 + 3 = 99 <= 100; but adding CJK would be 96 + 2 + 3 = 101 > 100
    const text = "a".repeat(96) + "中" + "b".repeat(20);
    const result = truncate(text, 100);
    expect(stringWidth(result)).toBeLessThanOrEqual(100);
    expect(result).toBe("a".repeat(96) + "...");
  });
});
