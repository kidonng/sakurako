import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import * as cheerio from "cheerio";
import {
  extractFirstParagraph,
  extractUrls,
  prepareOutgoingImage,
  scrapeAll,
  scrapeMetadata,
} from "../src/LinkPreview.ts";

describe("LinkPreviewEngine", () => {
  it("extracts and normalizes URLs from text", () => {
    const text = "Check out https://github.com and http://example.com/test?a=1";
    const urls = extractUrls(text);
    expect(urls).toEqual(["https://github.com", "http://example.com/test?a=1"]);
  });

  it("strips trailing punctuation and parentheses from URLs", () => {
    const text = "Visit (https://example.com/doc) and https://example.com/end.";
    const urls = extractUrls(text);
    expect(urls).toEqual([
      "https://example.com/doc",
      "https://example.com/end",
    ]);
  });

  it("deduplicates identical URLs while preserving order", () => {
    const text = "https://example.com https://test.org https://example.com";
    const urls = extractUrls(text);
    expect(urls).toEqual(["https://example.com", "https://test.org"]);
  });
  it("ignores scheme-less tokens such as filenames, e-mails, and bare domains", () => {
    const text =
      "Email me at kid@example.com or read README.md and check config.sh or example.com";
    const urls = extractUrls(text);
    expect(urls).toEqual([]);
  });

  it("ignores URLs embedded inside CQ codes (image, record, video, json, etc.)", () => {
    const text =
      "[CQ:image,file=0D09E17787BF2D57986E4271AA599A6D.jpg,url=https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=test]";
    expect(extractUrls(text)).toEqual([]);

    const multiCq =
      "[CQ:image,url=https://example.com/pic.jpg][CQ:video,url=https://example.com/video.mp4]";
    expect(extractUrls(multiCq)).toEqual([]);
  });

  it("extracts URLs from messages containing both CQ codes and plain text URLs", () => {
    const text =
      "[CQ:reply,id=-1804965225] https://news.ycombinator.com/item?id=50261319 [CQ:image,file=test.jpg,url=https://example.com/ignore.png]";
    expect(extractUrls(text)).toEqual([
      "https://news.ycombinator.com/item?id=50261319",
    ]);
  });

  it("scrapes metadata from HTML successfully", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="A cool test page">
          <meta property="og:image" content="https://example.com/cover.png">
        </head>
        <body>Hello</body>
      </html>
    `;
    const mockFetch = async () => new Response(mockHtml, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://example.com",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A cool test page");
    expect(result.image).toBe("https://example.com/cover.png");
  });

  it("sends Sakurako/1.0 User-Agent header by default", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      capturedHeaders = init?.headers;
      return new Response("<html><head><title>OK</title></head></html>", {
        status: 200,
      });
    };
    await Effect.runPromise(
      scrapeMetadata(
        "https://example.com",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(capturedHeaders?.["User-Agent"]).toBe("Sakurako/1.0");
  });

  it("sends custom Danbooru User-Agent header for Danbooru URLs", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      capturedHeaders = init?.headers;
      return new Response("<html><head><title>Danbooru</title></head></html>", {
        status: 200,
      });
    };
    await Effect.runPromise(
      scrapeMetadata(
        "https://danbooru.donmai.us/posts/12459835",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(capturedHeaders?.["User-Agent"]).toBe(
      "Sakurako/1.0  (user #898759)",
    );
  });

  it("handles missing title, description, image gracefully", async () => {
    const mockHtml = "<html><head></head><body>No meta</body></html>";
    const mockFetch = async () => new Response(mockHtml, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://example.com",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.url).toBe("https://example.com");
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.image).toBeUndefined();
  });

  it("fails when HTTP status is not 200", async () => {
    const mockFetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });
    const program = scrapeMetadata(
      "https://example.com/missing",
      mockFetch as unknown as typeof fetch,
    );
    const error = await Effect.runPromise(program.pipe(Effect.flip));

    expect(error).toContain("HTTP 404");
  });
  it("blocks SSRF attempts on localhost and private IP addresses", async () => {
    const programLocalhost = scrapeMetadata("http://localhost:3000");
    const errorLocalhost = await Effect.runPromise(
      programLocalhost.pipe(Effect.flip),
    );
    expect(errorLocalhost).toContain("Blocked private or local address");

    const programIp = scrapeMetadata("http://127.0.0.1:8080/secret");
    const errorIp = await Effect.runPromise(programIp.pipe(Effect.flip));
    expect(errorIp).toContain("Blocked private or local address");

    const programPrivate = scrapeMetadata("http://192.168.1.1/admin");
    const errorPrivate = await Effect.runPromise(
      programPrivate.pipe(Effect.flip),
    );
    expect(errorPrivate).toContain("Blocked private or local address");

    const programIpv6 = scrapeMetadata("http://[::1]:8080");
    const errorIpv6 = await Effect.runPromise(programIpv6.pipe(Effect.flip));
    expect(errorIpv6).toContain("Blocked private or local address");
  });

  it("scrapeAll aggregates successes and failures concurrently", async () => {
    const mockFetch = async (input: unknown) => {
      const urlStr = String(input);
      if (urlStr.includes("fail")) {
        return new Response("Error", { status: 500 });
      }
      return new Response(
        "<html><head><title>Success Title</title></head></html>",
        { status: 200 },
      );
    };

    const results = await Effect.runPromise(
      scrapeAll(
        ["https://ok.com", "https://fail.com"],
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(results).toHaveLength(2);
    const first = results[0];
    const second = results[1];
    expect(first?._tag).toBe("Success");
    if (first?._tag === "Success") {
      expect(first.data.title).toBe("Success Title");
    }
    expect(second?._tag).toBe("Failure");
    if (second?._tag === "Failure") {
      expect(second.url).toBe("https://fail.com");
      expect(second.reason).toContain("HTTP 500");
    }
  });

  it("scrapes news.ycombinator.com top-level submission and extracts link as description", async () => {
    const hnHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Git for the US Code | Hacker News</title></head>
        <body>
          <tr class="athing submission" id="50268380">
            <td class="title">
              <span class="titleline">
                <a href="https://lexifina.com/blog/git-for-the-us-code">Git for the US Code</a>
              </span>
            </td>
          </tr>
        </body>
      </html>
    `;
    const mockFetch = async () => new Response(hnHtml, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://news.ycombinator.com/item?id=50268380",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.title).toBe("Git for the US Code | Hacker News");
    expect(result.description).toBe(
      "https://lexifina.com/blog/git-for-the-us-code",
    );
  });

  it("scrapes news.ycombinator.com Ask HN without setting link description", async () => {
    const askHnHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Ask HN: What are you working on? | Hacker News</title></head>
        <body>
          <tr class="athing submission" id="50260146">
            <td class="title">
              <span class="titleline">
                <a href="item?id=50260146">Ask HN: What are you working on?</a>
              </span>
            </td>
          </tr>
        </body>
      </html>
    `;
    const mockFetch = async () => new Response(askHnHtml, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://news.ycombinator.com/item?id=50260146",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.title).toBe("Ask HN: What are you working on? | Hacker News");
    expect(result.description).toBeUndefined();
  });

  it("scrapes news.ycombinator.com comment without setting link description", async () => {
    const commentHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Comment Title | Hacker News</title></head>
        <body>
          <table class="fatitem">
            <tr class="athing" id="43180000">
              <td class="default">
                <div class="comment">
                  <a href="https://example.com">https://example.com</a>
                </div>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
    const mockFetch = async () => new Response(commentHtml, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://news.ycombinator.com/item?id=43180000",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.title).toBe("Comment Title | Hacker News");
    expect(result.description).toBeUndefined();
  });

  it("ignores SVG images when scraping metadata", async () => {
    const htmlWithSvg = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>SVG Site</title>
          <meta property="og:image" content="https://example.com/logo.svg">
        </head>
        <body><img src="y18.svg"></body>
      </html>
    `;
    const mockFetch = async () => new Response(htmlWithSvg, { status: 200 });
    const result = await Effect.runPromise(
      scrapeMetadata(
        "https://example.com",
        mockFetch as unknown as typeof fetch,
      ),
    );

    expect(result.image).toBeUndefined();
  });

  describe("prepareOutgoingImage", () => {
    it("leaves regular URLs untouched when sendImageAsBase64 is false", async () => {
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/image.png"),
      );
      expect(result).toBe("https://example.com/image.png");
    });

    it("downloads and encodes image to base64 for Danbooru URLs", async () => {
      const mockBytes = new Uint8Array([1, 2, 3, 4]);
      const mockFetch = async () =>
        new Response(mockBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      const result = await Effect.runPromise(
        prepareOutgoingImage(
          "https://cdn.donmai.us/original/123.jpg",
          mockFetch as unknown as typeof fetch,
        ),
      );
      expect(result).toBe(
        "base64://" + Buffer.from(mockBytes).toString("base64"),
      );
    });

    it("returns undefined when image download fails", async () => {
      const mockFetch = async () =>
        new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      const result = await Effect.runPromise(
        prepareOutgoingImage(
          "https://cdn.donmai.us/original/missing.jpg",
          mockFetch as unknown as typeof fetch,
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks private hostnames and local addresses", async () => {
      const result = await Effect.runPromise(
        prepareOutgoingImage("http://127.0.0.1:8080/secret.jpg"),
      );
      expect(result).toBeUndefined();
    });
  });

  describe("extractFirstParagraph", () => {
    it("prioritizes semantic containers over generic p", () => {
      const $ = cheerio.load(`
        <body>
          <p>Generic intro</p>
          <article><p>Article main content</p></article>
        </body>
      `);
      expect(extractFirstParagraph($)).toBe("Article main content");
    });

    it("ignores paragraphs inside noise containers", () => {
      const $ = cheerio.load(`
        <body>
          <header><p>Header notice</p></header>
          <nav><p>Nav links</p></nav>
          <article>
            <aside><p>Sidebar note</p></aside>
            <p>Real article paragraph.</p>
          </article>
          <footer><p>Footer copyright</p></footer>
        </body>
      `);
      expect(extractFirstParagraph($)).toBe("Real article paragraph.");
    });

    it("skips empty and whitespace-only paragraphs", () => {
      const $ = cheerio.load(`
        <body>
          <p></p>
          <p>   \n\t  </p>
          <p>&nbsp;</p>
          <p>First valid text.</p>
        </body>
      `);
      expect(extractFirstParagraph($)).toBe("First valid text.");
    });

    it("collapses multiple whitespaces and newlines", () => {
      const $ = cheerio.load(`
        <main>
          <p>
            Hello\n\n   world! \t This is
            Sakurako.
          </p>
        </main>
      `);
      expect(extractFirstParagraph($)).toBe("Hello world! This is Sakurako.");
    });

    it("returns undefined when no valid paragraph exists", () => {
      const $ = cheerio.load(`
        <body>
          <header><p>Only header</p></header>
        </body>
      `);
      expect(extractFirstParagraph($)).toBeUndefined();
    });
  });
});
