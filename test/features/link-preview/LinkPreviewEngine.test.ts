import { describe, expect, it } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { makeTestHttpClient } from "../../TestHttpClient.ts";
import * as cheerio from "cheerio";
import {
  extractFirstParagraph,
  extractUrls,
  MAX_IMAGE_BYTES,
  prepareOutgoingImage,
  scrapeAll,
  scrapeMetadata,
} from "../../../src/features/link-preview/LinkPreview.ts";
import { DEFAULT_ACCEPT_HEADER } from "../../../src/features/link-preview/LinkPreviewSites.ts";

describe("LinkPreviewEngine", () => {
  it("extracts and normalizes URLs from text", () => {
    const text = "Check out https://github.com and http://example.com/test?a=1";
    const urls = extractUrls(text);
    expect(urls).toEqual(["https://github.com", "http://example.com/test?a=1"]);
  });
  it("preserves trailing slashes on URL paths", () => {
    const text = "See https://tree-sitter.github.io/tree-sitter/ for docs";
    const urls = extractUrls(text);
    expect(urls).toEqual(["https://tree-sitter.github.io/tree-sitter/"]);
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
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(mockHtml, { status: 200 })),
        ),
      ),
    );

    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A cool test page");
    expect(result.image).toBe("https://example.com/cover.png");
  });

  it("resolves relative images against redirected response.url", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Redirected Page</title></head>
        <body><img src="assets/images/logo.png"></body>
      </html>
    `;
    const layer = makeTestHttpClient(() => {
      const res = new Response(mockHtml, { status: 200 });
      Object.defineProperty(res, "url", {
        value: "https://example.com/subdir/",
      });
      return res;
    });
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com/subdir").pipe(Effect.provide(layer)),
    );

    expect(result.image).toBe(
      "https://example.com/subdir/assets/images/logo.png",
    );
  });

  it("sends Sakurako/1.0 User-Agent and standard Accept headers by default", async () => {
    let capturedUserAgent: string | undefined;
    let capturedAccept: string | undefined;
    const layer = makeTestHttpClient((req) => {
      capturedUserAgent = req.headers["user-agent"];
      capturedAccept = req.headers["accept"];
      return new Response("<html><head><title>OK</title></head></html>", {
        status: 200,
      });
    });
    await Effect.runPromise(
      scrapeMetadata("https://example.com").pipe(Effect.provide(layer)),
    );

    expect(capturedUserAgent).toBe("Sakurako/1.0");
    expect(capturedAccept).toBe(DEFAULT_ACCEPT_HEADER);
  });

  it("sends custom Danbooru User-Agent header for Danbooru URLs", async () => {
    let capturedUserAgent: string | undefined;
    const layer = makeTestHttpClient((req) => {
      capturedUserAgent = req.headers["user-agent"];
      return new Response("<html><head><title>Danbooru</title></head></html>", {
        status: 200,
      });
    });
    await Effect.runPromise(
      scrapeMetadata("https://danbooru.donmai.us/posts/12459835").pipe(
        Effect.provide(layer),
      ),
    );

    expect(capturedUserAgent).toBe("Sakurako/1.0  (user #898759)");
  });

  it("handles missing title, description, image gracefully", async () => {
    const mockHtml = "<html><head></head><body>No meta</body></html>";
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(mockHtml, { status: 200 })),
        ),
      ),
    );

    expect(result.url).toBe("https://example.com");
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.image).toBeUndefined();
  });
  it("falls back to first paragraph when description metadata is missing", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>No Description Page</title></head>
        <body>
          <nav><p>Menu</p></nav>
          <article>
            <p>This is the first real paragraph of the page content.</p>
          </article>
        </body>
      </html>
    `;
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com/no-desc").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(mockHtml, { status: 200 })),
        ),
      ),
    );

    expect(result.title).toBe("No Description Page");
    expect(result.description).toBe(
      "This is the first real paragraph of the page content.",
    );
  });

  it("prefers meta description over first paragraph fallback", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Meta Priority</title>
          <meta name="description" content="Official meta description">
        </head>
        <body>
          <main><p>Body paragraph content.</p></main>
        </body>
      </html>
    `;
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com/meta-priority").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(mockHtml, { status: 200 })),
        ),
      ),
    );

    expect(result.description).toBe("Official meta description");
  });

  it("fails when HTTP status is not 200", async () => {
    const layer = makeTestHttpClient(
      () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );
    const error = await Effect.runPromise(
      scrapeMetadata("https://example.com/missing").pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("HttpFetchError");
    if (error._tag === "HttpFetchError") {
      expect(error.status).toBe(404);
    }
    expect(error.message).toContain("HTTP 404 Not Found");
  });
  it("times out when response body reading stalls", async () => {
    const layer = makeTestHttpClient(() => {
      const stream = new ReadableStream({
        start() {
          // Intentionally stalls without emitting data
        },
      });
      return new Response(stream, { status: 200 });
    });

    const error = await Effect.runPromise(
      scrapeMetadata("https://example.com/stalled", "50 millis").pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("HttpFetchError");
    expect(error.message).toContain("timed out");
  });

  it("blocks SSRF attempts on localhost and private IP addresses", async () => {
    const dummyLayer = makeTestHttpClient(() => new Response(""));

    const errorLocalhost = await Effect.runPromise(
      scrapeMetadata("http://localhost:3000").pipe(
        Effect.provide(dummyLayer),
        Effect.flip,
      ),
    );
    expect(errorLocalhost._tag).toBe("BlockedHostError");
    expect(errorLocalhost.message).toBe("Blocked private or local address");

    const errorIp = await Effect.runPromise(
      scrapeMetadata("http://127.0.0.1:8080/secret").pipe(
        Effect.provide(dummyLayer),
        Effect.flip,
      ),
    );
    expect(errorIp._tag).toBe("BlockedHostError");
    expect(errorIp.message).toBe("Blocked private or local address");

    const errorPrivate = await Effect.runPromise(
      scrapeMetadata("http://192.168.1.1/admin").pipe(
        Effect.provide(dummyLayer),
        Effect.flip,
      ),
    );
    expect(errorPrivate._tag).toBe("BlockedHostError");
    expect(errorPrivate.message).toBe("Blocked private or local address");

    const errorIpv6 = await Effect.runPromise(
      scrapeMetadata("http://[::1]:8080").pipe(
        Effect.provide(dummyLayer),
        Effect.flip,
      ),
    );
    expect(errorIpv6._tag).toBe("BlockedHostError");
    expect(errorIpv6.message).toBe("Blocked private or local address");
  });

  it("scrapeAll aggregates successes and failures concurrently", async () => {
    const layer = makeTestHttpClient((req) => {
      if (req.url.includes("fail")) {
        return new Response("Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
      return new Response(
        "<html><head><title>Success Title</title></head></html>",
        { status: 200 },
      );
    });

    const results = await Effect.runPromise(
      scrapeAll(["https://ok.com", "https://fail.com"]).pipe(
        Effect.provide(layer),
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
      expect(second.error._tag).toBe("HttpFetchError");
      if (second.error._tag === "HttpFetchError") {
        expect(second.error.status).toBe(500);
      }
      expect(second.error.message).toContain("HTTP 500");
    }
  });

  it("logs warning on scrape failure with URL and reason, without logging on success", async () => {
    const loggedMessages: Array<{ level: string; message: string }> = [];
    const testLogger = Logger.make((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.map(String).join(" ")
        : String(options.message);
      loggedMessages.push({ level: options.logLevel, message: msg });
    });

    const layer = makeTestHttpClient((req) => {
      if (req.url.includes("fail")) {
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      }
      return new Response(
        "<html><head><title>Success Title</title></head></html>",
        { status: 200 },
      );
    });

    await Effect.runPromise(
      scrapeAll(["https://ok.com", "https://fail.com"]).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([testLogger]))),
      ),
    );

    const warnLogs = loggedMessages.filter((l) => l.level === "Warn");
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]?.message).toContain("https://fail.com");
    expect(warnLogs[0]?.message).toContain("HTTP 404 Not Found");

    const okLogs = loggedMessages.filter((l) =>
      l.message.includes("https://ok.com"),
    );
    expect(okLogs).toHaveLength(0);
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
    const result = await Effect.runPromise(
      scrapeMetadata("https://news.ycombinator.com/item?id=50268380").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(hnHtml, { status: 200 })),
        ),
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
    const result = await Effect.runPromise(
      scrapeMetadata("https://news.ycombinator.com/item?id=50260146").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(askHnHtml, { status: 200 })),
        ),
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
    const result = await Effect.runPromise(
      scrapeMetadata("https://news.ycombinator.com/item?id=43180000").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(commentHtml, { status: 200 })),
        ),
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
    const result = await Effect.runPromise(
      scrapeMetadata("https://example.com").pipe(
        Effect.provide(
          makeTestHttpClient(() => new Response(htmlWithSvg, { status: 200 })),
        ),
      ),
    );

    expect(result.image).toBeUndefined();
  });

  describe("prepareOutgoingImage", () => {
    it("downloads and encodes image to base64 by default for generic websites", async () => {
      const mockBytes = new Uint8Array([5, 6, 7, 8]);
      const layer = makeTestHttpClient(
        () =>
          new Response(mockBytes, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/image.png").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBe(
        "base64://" + Buffer.from(mockBytes).toString("base64"),
      );
    });

    it("downloads and encodes image to base64 for Danbooru URLs", async () => {
      const mockBytes = new Uint8Array([1, 2, 3, 4]);
      const layer = makeTestHttpClient(
        () =>
          new Response(mockBytes, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://cdn.donmai.us/original/123.jpg").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBe(
        "base64://" + Buffer.from(mockBytes).toString("base64"),
      );
    });

    it("returns undefined when image download fails", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("Not Found", {
            status: 404,
            statusText: "Not Found",
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://cdn.donmai.us/original/missing.jpg").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks private hostnames and local addresses", async () => {
      const dummyLayer = makeTestHttpClient(() => new Response(""));
      const result = await Effect.runPromise(
        prepareOutgoingImage("http://127.0.0.1:8080/secret.jpg").pipe(
          Effect.provide(dummyLayer),
        ),
      );
      expect(result).toBeUndefined();
    });
    it("blocks image when declared Content-Length exceeds MAX_IMAGE_BYTES", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Length": "15000000",
            },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/huge.jpg").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks image when body size exceeds MAX_IMAGE_BYTES without Content-Length", async () => {
      const oversizedBytes = new Uint8Array(11 * 1024 * 1024);
      const layer = makeTestHttpClient(
        () =>
          new Response(oversizedBytes, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/oversized.jpg").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks non-image Content-Type (e.g. text/html)", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("<html>Error</html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/error-page.png").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks missing Content-Type", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/no-content-type.png").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("blocks SVG images by Content-Type (image/svg+xml)", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("<svg></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/vector.svg").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBeUndefined();
    });

    it("accepts valid image with Content-Type parameters", async () => {
      const mockBytes = new Uint8Array([1, 2, 3]);
      const layer = makeTestHttpClient(
        () =>
          new Response(mockBytes, {
            status: 200,
            headers: { "Content-Type": "image/png; charset=binary" },
          }),
      );
      const result = await Effect.runPromise(
        prepareOutgoingImage("https://example.com/photo.png").pipe(
          Effect.provide(layer),
        ),
      );
      expect(result).toBe(
        "base64://" + Buffer.from(mockBytes).toString("base64"),
      );
    });

    it("exports MAX_IMAGE_BYTES constant as 10 MiB", () => {
      expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
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

    it("treats <br> tags as spaces instead of gluing words together", () => {
      const $ = cheerio.load(`
        <article>
          <p>Hello<br>world &amp; <b>friends</b><br/>again</p>
        </article>
      `);
      expect(extractFirstParagraph($)).toBe("Hello world & friends again");
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
