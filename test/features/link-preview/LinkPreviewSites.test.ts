import { describe, expect, it } from "bun:test";
import * as cheerio from "cheerio";
import {
  DANBOORU_USER_AGENT,
  DEFAULT_USER_AGENT,
  danbooruCustomizer,
  findSiteCustomizer,
  getUserAgent,
  githubCustomizer,
  hackerNewsCustomizer,
  shouldFetchImageLocally,
} from "../../../src/features/link-preview/LinkPreviewSites.ts";

describe("LinkPreviewSites", () => {
  describe("findSiteCustomizer", () => {
    it("matches github.com URLs case-insensitively", () => {
      expect(
        findSiteCustomizer("https://github.com/kidonng/sakurako")?.name,
      ).toBe("github.com");
      expect(
        findSiteCustomizer("https://WWW.GITHUB.COM/owner/repo")?.name,
      ).toBe("github.com");
    });

    it("matches news.ycombinator.com URLs", () => {
      expect(
        findSiteCustomizer("https://news.ycombinator.com/item?id=12345")?.name,
      ).toBe("news.ycombinator.com");
      expect(
        findSiteCustomizer("https://www.news.ycombinator.com/item?id=12345")
          ?.name,
      ).toBe("news.ycombinator.com");
    });
    it("matches danbooru.donmai.us and related donmai.us URLs", () => {
      expect(
        findSiteCustomizer("https://danbooru.donmai.us/posts/12459835")?.name,
      ).toBe("danbooru.donmai.us");
      expect(
        findSiteCustomizer("https://testbooru.donmai.us/posts/1")?.name,
      ).toBe("danbooru.donmai.us");
      expect(
        findSiteCustomizer("https://safebooru.donmai.us/posts/1")?.name,
      ).toBe("danbooru.donmai.us");
    });

    it("returns undefined for unrecognized or invalid URLs", () => {
      expect(findSiteCustomizer("https://example.com")).toBeUndefined();
      expect(findSiteCustomizer("not-a-valid-url")).toBeUndefined();
    });
  });

  describe("githubCustomizer", () => {
    it("hides title and description when isSingle is true", () => {
      const options = githubCustomizer.formatItem?.({
        metadata: {
          url: "https://github.com/kidonng/sakurako",
          title: "kidonng/sakurako",
          description: "A QQ bot",
          image: "https://example.com/cover.png",
        },
        isSingle: true,
      });

      expect(options).toEqual({
        hideDescription: true,
        hideTitle: true,
      });
    });

    it("hides description but preserves title when isSingle is false", () => {
      const options = githubCustomizer.formatItem?.({
        metadata: {
          url: "https://github.com/kidonng/sakurako",
          title: "kidonng/sakurako",
          description: "A QQ bot",
          image: "https://example.com/cover.png",
        },
        isSingle: false,
      });

      expect(options).toEqual({
        hideDescription: true,
        hideTitle: false,
      });
    });
  });

  describe("hackerNewsCustomizer", () => {
    const getHnDescription = hackerNewsCustomizer.metascraperRules?.description;

    it("extracts external link on top-level submission", () => {
      const html = `<span class="titleline"><a href="https://lexifina.com/blog/git-for-the-us-code">Git for the US Code</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50268380",
      });

      expect(desc).toBe("https://lexifina.com/blog/git-for-the-us-code");
    });

    it("decodes HTML entities in external links", () => {
      const html = `<span class="titleline"><a href="https://example.com/article?ref=hn&amp;id=42">Article</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50268380",
      });

      expect(desc).toBe("https://example.com/article?ref=hn&id=42");
    });

    it("excludes Ask HN self posts with relative item links", () => {
      const html = `<span class="titleline"><a href="item?id=50260146">DietPi v10.8 has been released</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50260146",
      });

      expect(desc).toBeUndefined();
    });

    it("excludes Ask HN self posts with absolute item links", () => {
      const html = `<span class="titleline"><a href="https://news.ycombinator.com/item?id=50260146">Ask HN: What are you working on?</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50260146",
      });

      expect(desc).toBeUndefined();
    });

    it("excludes comment pages lacking titleline", () => {
      const html = `<div class="comment"><div class="commtext">A comment with a link <a href="https://example.com">example</a></div></div>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=43180000",
      });

      expect(desc).toBeUndefined();
    });

    it("excludes non-item pages such as the frontpage", () => {
      const html = `<span class="titleline"><a href="https://example.com">Story</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = getHnDescription?.({
        htmlDom,
        url: "https://news.ycombinator.com/",
      });

      expect(desc).toBeUndefined();
    });

    it("hides image via formatItem", () => {
      const options = hackerNewsCustomizer.formatItem?.({
        metadata: {
          url: "https://news.ycombinator.com/item?id=50268380",
          title: "Git for the US Code | Hacker News",
        },
        isSingle: true,
      });

      expect(options?.hideImage).toBe(true);
    });
  });

  describe("danbooruCustomizer", () => {
    it("has the custom userAgent for danbooru", () => {
      expect(danbooruCustomizer.userAgent).toBe("Sakurako/1.0  (user #898759)");
    });
    it("does not explicitly override fetchImageLocally on danbooruCustomizer", () => {
      expect(danbooruCustomizer.fetchImageLocally).toBeUndefined();
    });
    it("hides description via formatItem", () => {
      const options = danbooruCustomizer.formatItem?.({
        metadata: {
          url: "https://danbooru.donmai.us/posts/12459835",
          title: "Title",
          description: "View this image",
        },
        isSingle: true,
      });
      expect(options?.hideDescription).toBe(true);
    });
  });

  describe("getUserAgent", () => {
    it("returns default UA for generic websites", () => {
      expect(getUserAgent("https://example.com")).toBe(DEFAULT_USER_AGENT);
      expect(getUserAgent("https://github.com/kidonng/sakurako")).toBe(
        DEFAULT_USER_AGENT,
      );
      expect(getUserAgent(new URL("https://example.com"))).toBe("Sakurako/1.0");
    });

    it("returns Danbooru UA for danbooru domains", () => {
      expect(getUserAgent("https://danbooru.donmai.us/posts/12459835")).toBe(
        DANBOORU_USER_AGENT,
      );
      expect(
        getUserAgent(new URL("https://danbooru.donmai.us/posts/12459835")),
      ).toBe("Sakurako/1.0  (user #898759)");
    });
  });

  describe("shouldFetchImageLocally", () => {
    it("returns true by default for generic websites", () => {
      expect(shouldFetchImageLocally("https://example.com/cover.png")).toBe(
        true,
      );
    });

    it("returns true for Danbooru image URLs", () => {
      expect(
        shouldFetchImageLocally(
          "https://cdn.donmai.us/original/3f/83/3f838e2c11d37cf557cf3f7ac284895b.jpg",
        ),
      ).toBe(true);
    });
  });
});
