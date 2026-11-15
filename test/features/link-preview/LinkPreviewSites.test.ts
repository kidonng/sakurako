/* oxlint-disable effecttsgo/unstable-api-usage */
import * as cheerio from "cheerio";
import createMetascraper from "metascraper";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { DanbooruTagMatcher } from "../../../src/features/danbooru/DanbooruTagMatcher.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";
import {
  danbooruPostScraper,
  getSiteDisplayPolicy,
  hackerNewsRules,
  pixivRules,
  scrapeWithSiteOverride,
  siteMetascraperRules,
} from "../../../src/features/link-preview/LinkPreviewSites.ts";

describe("LinkPreviewSites", () => {
  describe("danbooruPostScraper & scrapeWithSiteOverride", () => {
    it("matches donmai.us post URLs across subdomains", () => {
      expect(
        danbooruPostScraper.match(
          new URL("https://danbooru.donmai.us/posts/12459835"),
        ),
      ).toBe(true);
      expect(
        danbooruPostScraper.match(
          new URL("https://testbooru.donmai.us/posts/1"),
        ),
      ).toBe(true);
      expect(
        danbooruPostScraper.match(
          new URL("https://safebooru.donmai.us/posts/1"),
        ),
      ).toBe(true);
    });

    it("does not match non-post or non-donmai URLs and skips HTTP calls", async () => {
      const nonPostUrl = new URL(
        "https://danbooru.donmai.us/posts?tags=cat_ears",
      );
      const otherUrl = new URL("https://example.com/posts/123");

      expect(danbooruPostScraper.match(nonPostUrl)).toBe(false);
      expect(danbooruPostScraper.match(otherUrl)).toBe(false);

      const httpLayer = makeTestHttpClient(() => {
        throw new Error("Should not be called");
      });

      const nonPostMetadata = await Effect.runPromise(
        scrapeWithSiteOverride(nonPostUrl).pipe(Effect.provide(httpLayer)),
      );
      const otherMetadata = await Effect.runPromise(
        scrapeWithSiteOverride(otherUrl).pipe(Effect.provide(httpLayer)),
      );

      expect(nonPostMetadata).toBeUndefined();
      expect(otherMetadata).toBeUndefined();
    });

    it("fetches post JSON directly and formats preview with Chinese translations", async () => {
      const mockPost = {
        id: 12459835,
        large_file_url: "https://example.com/large.jpg",
        preview_file_url: "https://example.com/preview.jpg",
        tag_string_character: "moriya_suwako",
        tag_string_copyright: "touhou",
        tag_string_artist: "moni_monico",
        tag_string_general: "",
      };

      const httpLayer = makeTestHttpClient((req) => {
        expect(req.url).toBe("https://danbooru.donmai.us/posts/12459835.json");
        expect(req.headers["user-agent"]).toBe("Sakurako/1.0 (user #898759)");
        return new Response(JSON.stringify(mockPost), { status: 200 });
      });

      const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
        matchTag: () => Effect.succeed(undefined as string | undefined),
        matchQuery: () => Effect.succeed([]),
        getTagTranslations: () =>
          Effect.succeed(
            new Map([
              ["moriya_suwako", "泄矢诹访子（东方Project）"],
              ["touhou", "东方Project"],
            ]),
          ),
      });

      const metadata = await Effect.runPromise(
        scrapeWithSiteOverride(
          new URL("https://danbooru.donmai.us/posts/12459835"),
        ).pipe(Effect.provide(Layer.merge(httpLayer, MatcherMock))),
      );

      expect(metadata).toEqual({
        url: "https://danbooru.donmai.us/posts/12459835",
        title: "泄矢诹访子 (东方Project) 画师 moni_monico",
        image: "https://example.com/large.jpg",
        fallbackImage: "https://example.com/preview.jpg",
      });
    });

    it("fails with 404 when post JSON returns 404", async () => {
      const httpLayer = makeTestHttpClient(() => {
        return new Response("Not Found", { status: 404 });
      });

      const error = await Effect.runPromise(
        scrapeWithSiteOverride(
          new URL("https://danbooru.donmai.us/posts/9999999"),
        ).pipe(Effect.provide(httpLayer), Effect.flip),
      );
      expect(error._tag).toBe("HttpNotFoundError");
      if (error._tag === "HttpNotFoundError") {
        expect(error.status).toBe(404);
      }
    });

    it("returns undefined to fall back when post JSON returns 429", async () => {
      const httpLayer = makeTestHttpClient(() => {
        return new Response("Too Many Requests", { status: 429 });
      });

      const metadata = await Effect.runPromise(
        scrapeWithSiteOverride(
          new URL("https://danbooru.donmai.us/posts/9999999"),
        ).pipe(Effect.provide(httpLayer)),
      );
      expect(metadata).toBeUndefined();
    });
  });

  describe("hackerNewsRules", () => {
    it("gates rules via test() for HN item URLs only", () => {
      const emptyDom = cheerio.load("<html></html>");
      expect(
        hackerNewsRules.test({
          htmlDom: emptyDom,
          url: "https://news.ycombinator.com/item?id=50268380",
        }),
      ).toBe(true);
      expect(
        hackerNewsRules.test({
          htmlDom: emptyDom,
          url: "https://news.ycombinator.com/",
        }),
      ).toBe(false);
      expect(
        hackerNewsRules.test({
          htmlDom: emptyDom,
          url: "https://example.com/item?id=50268380",
        }),
      ).toBe(false);
      expect(
        hackerNewsRules.test({
          htmlDom: emptyDom,
          url: "not-a-valid-url",
        }),
      ).toBe(false);
    });

    it("extracts external link on top-level submission", () => {
      const html = `<span class="titleline"><a href="https://lexifina.com/blog/git-for-the-us-code">Git for the US Code</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = hackerNewsRules.description({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50268380",
      });

      expect(desc).toBe("https://lexifina.com/blog/git-for-the-us-code");
    });

    it("decodes HTML entities in external links", () => {
      const html = `<span class="titleline"><a href="https://example.com/article?ref=hn&amp;id=42">Article</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = hackerNewsRules.description({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50268380",
      });

      expect(desc).toBe("https://example.com/article?ref=hn&id=42");
    });

    it("excludes Ask HN self posts with relative item links", () => {
      const html = `<span class="titleline"><a href="item?id=50260146">DietPi v10.8 has been released</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = hackerNewsRules.description({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50260146",
      });

      expect(desc).toBeUndefined();
    });

    it("excludes Ask HN self posts with absolute item links", () => {
      const html = `<span class="titleline"><a href="https://news.ycombinator.com/item?id=50260146">Ask HN: What are you working on?</a></span>`;
      const htmlDom = cheerio.load(html);

      const desc = hackerNewsRules.description({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=50260146",
      });

      expect(desc).toBeUndefined();
    });

    it("excludes comment pages lacking titleline", () => {
      const html = `<div class="comment"><div class="commtext">A comment with a link <a href="https://example.com">example</a></div></div>`;
      const htmlDom = cheerio.load(html);

      const desc = hackerNewsRules.description({
        htmlDom,
        url: "https://news.ycombinator.com/item?id=43180000",
      });

      expect(desc).toBeUndefined();
    });

    it("gates out frontpage through createMetascraper(siteMetascraperRules)", async () => {
      const scraper = createMetascraper([...siteMetascraperRules]);
      const html = `<span class="titleline"><a href="https://example.com">Story</a></span>`;

      const metadata = await scraper({
        html,
        url: "https://news.ycombinator.com/",
      });

      expect(metadata.description).toBeNull();
    });
  });

  describe("pixivRules", () => {
    it("gates rules via test() for pixiv artwork URLs only", () => {
      const emptyDom = cheerio.load("<html></html>");
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "https://www.pixiv.net/artworks/82775556",
        }),
      ).toBe(true);
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "https://pixiv.net/en/artworks/82775556",
        }),
      ).toBe(true);
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "https://www.pixiv.net/users/12345",
        }),
      ).toBe(false);
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "https://www.pixiv.net/ranking.php",
        }),
      ).toBe(false);
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "https://other.com/artworks/82775556",
        }),
      ).toBe(false);
      expect(
        pixivRules.test({
          htmlDom: emptyDom,
          url: "not-a-valid-url",
        }),
      ).toBe(false);
    });

    it("extracts pixiv.cat image URL from standard artwork path", () => {
      const image = pixivRules.image({
        url: "https://www.pixiv.net/artworks/82775556",
        htmlDom: cheerio.load("<html></html>"),
      });
      expect(image).toBe("https://pixiv.cat/82775556.jpg");
    });

    it("extracts pixiv.cat image URL with language prefix", () => {
      const image = pixivRules.image({
        url: "https://www.pixiv.net/en/artworks/82775556",
        htmlDom: cheerio.load("<html></html>"),
      });
      expect(image).toBe("https://pixiv.cat/82775556.jpg");
    });

    it("extracts fallbackImage from og:image or twitter:image", () => {
      const html = `<html><head><meta property="og:image" content="https://embed.pixiv.net/decorate.php?illust_id=82775556"></head></html>`;
      const fallback = pixivRules.fallbackImage({
        url: "https://www.pixiv.net/artworks/82775556",
        htmlDom: cheerio.load(html),
      });
      expect(fallback).toBe(
        "https://embed.pixiv.net/decorate.php?illust_id=82775556",
      );
    });

    it("gates out non-artwork pixiv URLs through createMetascraper(siteMetascraperRules)", async () => {
      const scraper = createMetascraper([...siteMetascraperRules]);
      const html = `<html><head><meta property="og:image" content="https://example.com/avatar.jpg"></head></html>`;

      const metadata = await scraper({
        html,
        url: "https://www.pixiv.net/users/12345",
      });

      expect(metadata.image).toBeNull();
    });
  });

  describe("getSiteDisplayPolicy", () => {
    it("hides title and description for github.com when isSingle is true", () => {
      expect(
        getSiteDisplayPolicy("https://github.com/kidonng/sakurako", {
          isSingle: true,
        }),
      ).toEqual({
        hideDescription: true,
        hideTitle: true,
      });
      expect(
        getSiteDisplayPolicy("https://GITHUB.COM/owner/repo", {
          isSingle: true,
        }),
      ).toEqual({
        hideDescription: true,
        hideTitle: true,
      });
    });

    it("hides description but preserves title for github.com when isSingle is false", () => {
      expect(
        getSiteDisplayPolicy("https://github.com/kidonng/sakurako", {
          isSingle: false,
        }),
      ).toEqual({
        hideDescription: true,
        hideTitle: false,
      });
    });

    it("hides image for news.ycombinator.com", () => {
      expect(
        getSiteDisplayPolicy("https://news.ycombinator.com/item?id=12345", {
          isSingle: true,
        }),
      ).toEqual({
        hideImage: true,
      });
    });

    it("hides description for donmai.us post and non-post URLs", () => {
      expect(
        getSiteDisplayPolicy("https://danbooru.donmai.us/posts/12459835", {
          isSingle: true,
        }),
      ).toEqual({
        hideDescription: true,
      });
      expect(
        getSiteDisplayPolicy("https://danbooru.donmai.us/posts?tags=cat_ears", {
          isSingle: true,
        }),
      ).toEqual({
        hideDescription: true,
      });
    });

    it("returns undefined for unrecognized or invalid URLs", () => {
      expect(
        getSiteDisplayPolicy("https://example.com", { isSingle: true }),
      ).toBeUndefined();
      expect(
        getSiteDisplayPolicy("not-a-valid-url", { isSingle: true }),
      ).toBeUndefined();
    });
  });
});
