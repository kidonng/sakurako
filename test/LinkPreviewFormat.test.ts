import { describe, expect, it } from "bun:test";
import { formatPreview, type ScrapingResult } from "../src/LinkPreview.ts";

describe("formatPreview", () => {
  it("returns null when all results are failures", () => {
    const results: ScrapingResult[] = [
      { _tag: "Failure", url: "https://a.com", reason: "HTTP 404" },
      { _tag: "Failure", url: "https://b.com", reason: "Timeout" },
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
      text: "My Title\nMy Description",
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
      text: "（无标题）\nMy Description",
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
      text: "1. First Title\nFirst Desc\n2. Second Title\nSecond Desc",
      image: "https://first.com/img1.png",
    });
  });

  it("formats multi-link with partial failures and picks first available image", () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://fail.com",
        reason: "HTTP 404",
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
    expect(formatted?.text).toContain("a".repeat(97) + "...");
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
      text: "1. GitHub - kidonng/sakurako\n2. Example Domain\nExample Description",
      image: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
    });
  });

  it("formats news.ycombinator.com link displaying description as external link", () => {
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
      text: "Git for the US Code | Hacker News\nhttps://lexifina.com/blog/git-for-the-us-code",
      image: "https://news.ycombinator.com/y18.svg",
    });
  });
});
