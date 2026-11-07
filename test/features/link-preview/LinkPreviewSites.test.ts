/* oxlint-disable effecttsgo/unstable-api-usage */
import * as cheerio from "cheerio";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { DanbooruTagMatcher } from "../../../src/features/danbooru/DanbooruTagMatcher.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";
import {
  DANBOORU_USER_AGENT,
  DEFAULT_USER_AGENT,
  danbooruCustomizer,
  extractPixivArtworkId,
  findSiteCustomizer,
  getUserAgent,
  githubCustomizer,
  hackerNewsCustomizer,
  pixivCustomizer,
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
        matchQuery: () => Effect.succeed({ tags: [], isModified: false }),
        getTagTranslations: () =>
          Effect.succeed(
            new Map([
              ["moriya_suwako", "泄矢诹访子（东方Project）"],
              ["touhou", "东方Project"],
            ]),
          ),
      });

      const metadata = await Effect.runPromise(
        danbooruCustomizer.scrape!({
          url: new URL("https://danbooru.donmai.us/posts/12459835"),
        }).pipe(Effect.provide(Layer.merge(httpLayer, MatcherMock))),
      );

      expect(metadata).toEqual({
        url: "https://danbooru.donmai.us/posts/12459835",
        title: "泄矢诹访子 (东方Project) 画师 moni_monico",
        image: "https://example.com/large.jpg",
        fallbackImage: "https://example.com/preview.jpg",
      });
    });

    it("falls back to English tags when DanbooruTagMatcher is unavailable", async () => {
      const mockPost = {
        id: 12459835,
        large_file_url: "https://example.com/large.jpg",
        tag_string_character: "moriya_suwako",
        tag_string_copyright: "touhou",
        tag_string_artist: "moni_monico",
        tag_string_general: "",
      };

      const httpLayer = makeTestHttpClient(() => {
        return new Response(JSON.stringify(mockPost), { status: 200 });
      });

      const metadata = await Effect.runPromise(
        danbooruCustomizer.scrape!({
          url: new URL("https://danbooru.donmai.us/posts/12459835"),
        }).pipe(Effect.provide(httpLayer)),
      );

      expect(metadata?.title).toBe("moriya suwako (touhou) 画师 moni_monico");
    });

    it("returns undefined for non-post URLs to let standard scraper handle them", async () => {
      const httpLayer = makeTestHttpClient(() => {
        throw new Error("Should not be called");
      });

      const metadata = await Effect.runPromise(
        danbooruCustomizer.scrape!({
          url: new URL("https://danbooru.donmai.us/posts?tags=cat_ears"),
        }).pipe(Effect.provide(httpLayer)),
      );

      expect(metadata).toBeUndefined();
    });

    it("fails with 404 when post JSON returns 404", async () => {
      const httpLayer = makeTestHttpClient(() => {
        return new Response("Not Found", { status: 404 });
      });

      const error = await Effect.runPromise(
        danbooruCustomizer.scrape!({
          url: new URL("https://danbooru.donmai.us/posts/9999999"),
        }).pipe(Effect.provide(httpLayer), Effect.flip),
      );

      expect(error._tag).toBe("HttpFetchError");
      expect(error.status).toBe(404);
    });
  });

  describe("pixivCustomizer", () => {
    it("matches pixiv.net and www.pixiv.net", () => {
      expect(
        findSiteCustomizer("https://www.pixiv.net/artworks/82775556")?.name,
      ).toBe("pixiv.net");
      expect(
        findSiteCustomizer("https://pixiv.net/artworks/82775556")?.name,
      ).toBe("pixiv.net");
      expect(
        findSiteCustomizer("https://other.com/artworks/82775556"),
      ).toBeUndefined();
    });

    it("extracts pixiv.cat image URL from standard artwork path", () => {
      const url = new URL("https://www.pixiv.net/artworks/82775556");
      const image = pixivCustomizer.metascraperRules?.image?.({
        url: url.href,
        htmlDom: cheerio.load("<html></html>"),
      });
      expect(image).toBe("https://pixiv.cat/82775556.jpg");
    });

    it("extracts pixiv.cat image URL with language prefix", () => {
      const url = new URL("https://www.pixiv.net/en/artworks/82775556");
      const image = pixivCustomizer.metascraperRules?.image?.({
        url: url.href,
        htmlDom: cheerio.load("<html></html>"),
      });
      expect(image).toBe("https://pixiv.cat/82775556.jpg");
    });

    it("returns undefined for non-artwork URLs", () => {
      const userUrl = new URL("https://www.pixiv.net/users/12345");
      expect(
        pixivCustomizer.metascraperRules?.image?.({
          url: userUrl.href,
          htmlDom: cheerio.load("<html></html>"),
        }),
      ).toBeUndefined();

      const rankingUrl = new URL("https://www.pixiv.net/ranking.php");
      expect(
        pixivCustomizer.metascraperRules?.image?.({
          url: rankingUrl.href,
          htmlDom: cheerio.load("<html></html>"),
        }),
      ).toBeUndefined();
    });

    it("extracts fallbackImage from og:image or twitter:image", () => {
      const html = `<html><head><meta property="og:image" content="https://embed.pixiv.net/decorate.php?illust_id=82775556"></head></html>`;
      const fallback = pixivCustomizer.metascraperRules?.fallbackImage?.({
        url: "https://www.pixiv.net/artworks/82775556",
        htmlDom: cheerio.load(html),
      });
      expect(fallback).toBe(
        "https://embed.pixiv.net/decorate.php?illust_id=82775556",
      );
    });

    it("extracts artwork ID using extractPixivArtworkId helper", () => {
      expect(
        extractPixivArtworkId(new URL("https://www.pixiv.net/artworks/123456")),
      ).toBe("123456");
      expect(
        extractPixivArtworkId(
          new URL("https://www.pixiv.net/ja/artworks/654321"),
        ),
      ).toBe("654321");
      expect(
        extractPixivArtworkId(new URL("https://www.pixiv.net/users/999")),
      ).toBeUndefined();
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
      ).toBe(DANBOORU_USER_AGENT);
    });
  });

  describe("shouldFetchImageLocally", () => {
    it("returns true by default for generic websites", () => {
      expect(shouldFetchImageLocally("https://example.com/cover.png")).toBe(
        true,
      );
    });
  });
});
