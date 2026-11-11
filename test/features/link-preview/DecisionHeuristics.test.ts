import { describe, expect, it } from "bun:test";
import {
  isGenericIconUrl,
  isInvalidTitle,
} from "../../../src/features/link-preview/DecisionHeuristics.ts";

describe("DecisionHeuristics", () => {
  describe("isInvalidTitle", () => {
    it("flags empty, undefined, and whitespace-only titles as invalid", () => {
      expect(isInvalidTitle(undefined)).toBe(true);
      expect(isInvalidTitle("")).toBe(true);
      expect(isInvalidTitle("   \n\t ")).toBe(true);
    });

    it("flags generic SPA placeholders as invalid", () => {
      expect(isInvalidTitle("React App")).toBe(true);
      expect(isInvalidTitle("react app")).toBe(true);
      expect(isInvalidTitle("Vite App")).toBe(true);
      expect(isInvalidTitle("Create React App")).toBe(true);
      expect(isInvalidTitle("Loading...")).toBe(true);
      expect(isInvalidTitle("加载中...")).toBe(true);
      expect(isInvalidTitle("加载中")).toBe(true);
    });

    it("flags standard error status titles as invalid", () => {
      expect(isInvalidTitle("404 Not Found")).toBe(true);
      expect(isInvalidTitle("404")).toBe(true);
      expect(isInvalidTitle("403 Forbidden")).toBe(true);
      expect(isInvalidTitle("500 Internal Server Error")).toBe(true);
      expect(isInvalidTitle("Not Found")).toBe(true);
      expect(isInvalidTitle("Error")).toBe(true);
      expect(isInvalidTitle("页面未找到")).toBe(true);
      expect(isInvalidTitle("网页不存在")).toBe(true);
    });

    it("accepts legitimate content titles", () => {
      expect(isInvalidTitle("Bliss (Windows XP)")).toBe(false);
      expect(isInvalidTitle("GitHub - Effect-TS/effect")).toBe(false);
      expect(isInvalidTitle("Hello World - My Personal Blog")).toBe(false);
      expect(isInvalidTitle("404 Ways to Optimize React")).toBe(false);
    });
  });

  describe("isGenericIconUrl", () => {
    it("flags undefined or empty URLs as generic/invalid", () => {
      expect(isGenericIconUrl(undefined)).toBe(true);
      expect(isGenericIconUrl("")).toBe(true);
    });

    it("flags URLs with icon, logo, favicon, avatar, or chevron keywords", () => {
      expect(isGenericIconUrl("https://example.com/assets/logo.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/favicon.ico")).toBe(true);
      expect(isGenericIconUrl("https://example.com/static/user-avatar.jpg")).toBe(
        true,
      );
      expect(isGenericIconUrl("https://example.com/images/nav-chevron.png")).toBe(
        true,
      );
      expect(isGenericIconUrl("https://example.com/ui/arrow-right.png")).toBe(
        true,
      );
      expect(isGenericIconUrl("https://example.com/spinner.gif")).toBe(true);
      expect(isGenericIconUrl("https://example.com/placeholder.png")).toBe(true);
      expect(isGenericIconUrl("https://example.com/icon-32x32.png")).toBe(true);
    });

    it("accepts legitimate content images", () => {
      expect(
        isGenericIconUrl(
          "https://i.ytimg.com/vi/AoNnbz237E0/maxresdefault.jpg",
        ),
      ).toBe(false);
      expect(
        isGenericIconUrl("https://example.com/uploads/2026/11/cover-photo.jpg"),
      ).toBe(false);
      expect(
        isGenericIconUrl("https://opengraph.githubassets.com/123/org/repo"),
      ).toBe(false);
    });
  });
});
