import { describe, expect, it } from "bun:test";
import {
  BlockedHostError,
  formatPreview,
  HttpFetchError,
  type ScrapingResult,
} from "../../../src/features/link-preview/LinkPreview.ts";

describe("formatPreview", () => {
  it("returns null when all results are failures", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://a.com",
        error: new HttpFetchError({
          url: "https://a.com",
          status: 404,
          statusText: "Not Found",
          detail: "HTTP status 404",
        }),
      },
      {
        _tag: "Failure",
        url: "https://b.com",
        error: new HttpFetchError({ url: "https://b.com", detail: "Timeout" }),
      },
    ];
    expect(formatPreview(results)).toBeNull();
  });

  it("formats single successful URL with all metadata", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          title: "My Title",
          description: "My Description",
          image: "https://example.com/pic.jpg",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "My Title\n> My Description",
      image: "https://example.com/pic.jpg",
    });
  });

  it("formats single successful URL with missing title as （无标题）", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          description: "My Description",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "（无标题）\n> My Description",
      image: undefined,
    });
  });

  it("formats single successful URL omitting description when missing", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          title: "Just Title",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "Just Title",
      image: undefined,
    });
  });

  it("formats multiple URLs with numbering, picking only the first image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://first.com",
          title: "First Title",
          description: "First Desc",
          image: "https://first.com/img1.png",
        },
      },
      {
        _tag: "Success",
        data: {
          url: "https://second.com",
          title: "Second Title",
          description: "Second Desc",
          image: "https://second.com/img2.png",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "1. First Title\n> First Desc\n2. Second Title\n> Second Desc",
      image: "https://first.com/img1.png",
    });
  });

  it("formats multi-link with partial failures and picks first available image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://fail.com",
        error: new HttpFetchError({
          url: "https://fail.com",
          status: 404,
          detail: "HTTP status 404",
        }),
      },
      {
        _tag: "Success",
        data: {
          url: "https://has-img.com",
          title: "Success Title",
          image: "https://has-img.com/img.png",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "1. [提取失败：HTTP 404]\n2. Success Title",
      image: "https://has-img.com/img.png",
    });
  });
  it("formats multiple URLs with mixed successes and failures using TaggedError message", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://success.com", title: "Success Title" },
      },
      {
        _tag: "Failure",
        url: "https://fail.com",
        error: new HttpFetchError({
          url: "https://fail.com",
          status: 404,
          statusText: "Not Found",
          detail: "HTTP status 404",
        }),
      },
      {
        _tag: "Failure",
        url: "http://127.0.0.1",
        error: new BlockedHostError({
          url: "http://127.0.0.1",
          hostname: "127.0.0.1",
        }),
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted?.text).toBe(
      "1. Success Title\n2. [提取失败：HTTP 404 Not Found]\n3. [提取失败：Blocked private or local address]",
    );
  });

  it("truncates long titles and descriptions in multi-link output", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://long.com",
          title: "中".repeat(60),
          description: "a".repeat(120),
        },
      },
      {
        _tag: "Success",
        data: {
          url: "https://short.com",
          title: "Short",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted?.text).toContain("1. " + "中".repeat(48) + "...");
    expect(formatted?.text).toContain("> " + "a".repeat(97) + "...");
    expect(formatted?.text).toContain("2. Short");
  });

  it("formats single github.com link hiding title and description when image is present", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://github.com/kidonng/sakurako",
          title: "GitHub - kidonng/sakurako",
          description: "A QQ bot",
          image: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "",
      image: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
    });
  });

  it("returns null for single github.com link without image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://github.com/kidonng/sakurako",
          title: "GitHub - kidonng/sakurako",
          description: "A QQ bot",
        },
      },
    ];
    expect(formatPreview(results)).toBeNull();
  });

  it("formats multi-link containing github.com by hiding description but keeping title", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://github.com/kidonng/sakurako",
          title: "GitHub - kidonng/sakurako",
          description: "A QQ bot",
          image: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
        },
      },
      {
        _tag: "Success",
        data: {
          url: "https://example.com",
          title: "Example Domain",
          description: "Example Description",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "1. GitHub - kidonng/sakurako\n2. Example Domain\n> Example Description",
      image: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
    });
  });

  it("formats news.ycombinator.com link displaying description as external link without image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.ycombinator.com/item?id=50268380",
          title: "Git for the US Code | Hacker News",
          description: "https://lexifina.com/blog/git-for-the-us-code",
          image: "https://news.ycombinator.com/y18.svg",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "Git for the US Code | Hacker News\n> https://lexifina.com/blog/git-for-the-us-code",
      image: undefined,
    });
  });

  it("filters out SVG image in single and multi-link formatPreview even if present in metadata", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://example.com/page",
          title: "Example Title",
          image: "https://example.com/vector.svg?query=1",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted?.image).toBeUndefined();
  });

  it("formats Danbooru link by hiding description", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://danbooru.donmai.us/posts/12459835",
          title: "moriya suwako (touhou) drawn by moni_monico | Danbooru",
          description: "View this 1536x2048 455 KB image",
          image:
            "https://cdn.donmai.us/original/3f/83/3f838e2c11d37cf557cf3f7ac284895b.jpg",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "moriya suwako (touhou) drawn by moni_monico | Danbooru",
      image:
        "https://cdn.donmai.us/original/3f/83/3f838e2c11d37cf557cf3f7ac284895b.jpg",
    });
  });

  it("returns null when single link is filtered", () => {
    const results: ScrapingResult[] = [
      { _tag: "Filtered", url: "https://example.com" },
    ];
    expect(formatPreview(results)).toBeNull();
  });

  it("returns null when all multiple links are filtered or failed", () => {
    const results: ScrapingResult[] = [
      { _tag: "Filtered", url: "https://example1.com" },
      {
        _tag: "Failure",
        url: "https://example2.com",
        error: new HttpFetchError({
          url: "https://example2.com",
          detail: "Timeout",
        }),
      },
      { _tag: "Filtered", url: "https://example3.com" },
    ];
    expect(formatPreview(results)).toBeNull();
  });

  it("formats multiple links with partial filtered placeholders and preserves valid image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Filtered",
        url: "https://filtered-news.com",
      },
      {
        _tag: "Success",
        data: {
          url: "https://useful-blog.com",
          title: "Useful Title",
          description: "Useful Desc",
          image: "https://useful-blog.com/cover.png",
        },
      },
      {
        _tag: "Filtered",
        url: "https://t.me/promo",
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted).toEqual({
      text: "1. （已过滤）\n2. Useful Title\n> Useful Desc\n3. （已过滤）",
      image: "https://useful-blog.com/cover.png",
    });
  });

  it("does not use image from a filtered link even if first in list", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Filtered",
        url: "https://ad-banner.com",
      },
      {
        _tag: "Success",
        data: {
          url: "https://valid.com",
          title: "Valid Title",
          image: "https://valid.com/picture.jpg",
        },
      },
    ];
    const formatted = formatPreview(results);
    expect(formatted?.image).toBe("https://valid.com/picture.jpg");
  });
});
