/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Redacted,
} from "effect";
import { HttpBody, HttpClient } from "effect/http";
import {
  createFirecrawlEngine,
  FallbackScrapeError,
  FallbackScraper,
  type ScraperEngine,
} from "../../../src/features/link-preview/FallbackScraper.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

function extractJsonBody(req: { body: unknown }): unknown {
  if (req.body instanceof HttpBody.Uint8Array) {
    const raw = new TextDecoder().decode(req.body.body);
    return JSON.parse(raw);
  }
  return null;
}

describe("FallbackScraper", () => {
  describe("Firecrawl engine", () => {
    it("sends keyless POST request with rawHtml format and 25000ms timeout and extracts html + metadata", async () => {
      let capturedMethod: string | undefined;
      let capturedUrl: string | undefined;
      let capturedAuth: string | undefined;
      let capturedBody: unknown;

      const httpLayer = makeTestHttpClient((req) => {
        capturedMethod = req.method;
        capturedUrl = req.url;
        capturedAuth = req.headers["authorization"];
        capturedBody = extractJsonBody(req);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              rawHtml: "<html><head><title>Article Title</title></head></html>",
              metadata: {
                title: "Fallback Title",
                ogTitle: "OG Article Title",
                description: "Fallback Desc",
                ogDescription: "OG Desc",
                ogImage: "https://example.com/cover.png",
                url: "https://example.com/final",
                statusCode: 200,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const engine = createFirecrawlEngine(client);
          return yield* engine.scrape("https://example.com/article");
        }).pipe(Effect.provide(httpLayer)),
      );

      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe("https://api.firecrawl.dev/v2/scrape");
      expect(capturedAuth).toBeUndefined();
      expect(capturedBody).toEqual({
        url: "https://example.com/article",
        formats: ["rawHtml"],
        timeout: 25000,
      });
      expect(result.engineId).toBe("firecrawl");
      expect(result.url).toBe("https://example.com/final");
      expect(result.html).toBe(
        "<html><head><title>Article Title</title></head></html>",
      );
      expect(result.metadata).toEqual({
        title: "OG Article Title",
        description: "OG Desc",
        image: "https://example.com/cover.png",
      });
    });

    it("attaches Bearer authorization header when API key is configured via BotConfig", async () => {
      let capturedAuth: string | undefined;
      const httpLayer = makeTestHttpClient((req) => {
        capturedAuth = req.headers["authorization"];
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              rawHtml: "<html><head><title>Authed</title></head></html>",
              metadata: { statusCode: 200 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          SNOWLUMA_WS_URL: "ws://127.0.0.1:3001/",
          SNOWLUMA_ACCESS_TOKEN: "token",
          FIRECRAWL_API_KEY: "fc_secret_key",
        }),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const scraper = yield* FallbackScraper;
          return yield* scraper.scrape("https://example.com/authed");
        }).pipe(
          Effect.provide(
            FallbackScraper.layer.pipe(
              Layer.provide(httpLayer),
              Layer.provide(configLayer),
            ),
          ),
        ),
      );

      expect(capturedAuth).toBe("Bearer fc_secret_key");
      expect(result.url).toBe("https://example.com/authed");
      expect(result.html).toContain("Authed");
    });

    it("normalizes array metadata values and succeeds when metadata.statusCode is absent", async () => {
      const httpLayer = makeTestHttpClient(
        () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                metadata: {
                  title: ["  ", "Array Title"],
                  description: ["Array Description"],
                  ogImage: ["https://example.com/array.png"],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* createFirecrawlEngine(client).scrape(
            "https://example.com/array-meta",
          );
        }).pipe(Effect.provide(httpLayer)),
      );

      expect(result.html).toBeUndefined();
      expect(result.url).toBe("https://example.com/array-meta");
      expect(result.metadata).toEqual({
        title: "Array Title",
        description: "Array Description",
        image: "https://example.com/array.png",
      });
    });

    it("fails when target metadata.statusCode is non-2xx even if success is true", async () => {
      const httpLayer = makeTestHttpClient(
        () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                rawHtml: "<html><head><title>Forbidden</title></head></html>",
                metadata: { statusCode: 403 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* createFirecrawlEngine(client).scrape(
            "https://example.com/blocked",
          );
        }).pipe(Effect.provide(httpLayer), Effect.flip),
      );

      expect(error).toBeInstanceOf(FallbackScrapeError);
      expect(error.engineId).toBe("firecrawl");
      expect(error.status).toBe(403);
    });

    it("fails when success is false or when rawHtml and metadata are empty", async () => {
      const unsuccessfulLayer = makeTestHttpClient(
        () =>
          new Response(
            JSON.stringify({
              success: false,
              error: "Scrape failed",
              code: "SCRAPE_FAILED",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const err1 = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* createFirecrawlEngine(client).scrape(
            "https://example.com/fail",
          );
        }).pipe(Effect.provide(unsuccessfulLayer), Effect.flip),
      );
      expect(err1).toBeInstanceOf(FallbackScrapeError);
      expect(err1.reason).toContain("Scrape failed");

      const emptyLayer = makeTestHttpClient(
        () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                rawHtml: "   ",
                metadata: { statusCode: 200 },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const err2 = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* createFirecrawlEngine(client).scrape(
            "https://example.com/empty",
          );
        }).pipe(Effect.provide(emptyLayer), Effect.flip),
      );
      expect(err2).toBeInstanceOf(FallbackScrapeError);
    });

    it("fast-fails without retrying when Firecrawl returns 429", async () => {
      let attempts = 0;
      const httpLayer = makeTestHttpClient(() => {
        attempts++;
        return new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        });
      });

      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* createFirecrawlEngine(
            client,
            Redacted.make("fc-key"),
          ).scrape("https://example.com/rate-limited");
        }).pipe(Effect.provide(httpLayer), Effect.flip),
      );

      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(FallbackScrapeError);
      expect(error.engineId).toBe("firecrawl");
      expect(error.status).toBe(429);
    });
  });

  describe("Multi-engine fallback & concurrency guard", () => {
    it("falls back sequentially to the next engine when the first engine fails", async () => {
      const loggedWarnings: string[] = [];
      const testLogger = Logger.make((options) => {
        if (options.logLevel === "Warn") {
          const msg = Array.isArray(options.message)
            ? options.message.map(String).join(" ")
            : String(options.message);
          loggedWarnings.push(msg);
        }
      });

      const engine1: ScraperEngine = {
        id: "engine-one",
        scrape: (url) =>
          Effect.fail(
            new FallbackScrapeError({
              engineId: "engine-one",
              url,
              reason: "HTTP 429 Too Many Requests",
              status: 429,
            }),
          ),
      };
      const engine2: ScraperEngine = {
        id: "engine-two",
        scrape: (url) =>
          Effect.succeed({
            engineId: "engine-two",
            url,
            html: "<html><head><title>Recovered by Engine 2</title></head></html>",
          }),
      };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const scraper = yield* FallbackScraper;
          return yield* scraper.scrape("https://example.com/post");
        }).pipe(
          Effect.provide(
            Layer.merge(
              FallbackScraper.layerFromEngines([engine1, engine2]),
              Logger.layer([testLogger]),
            ),
          ),
        ),
      );

      expect(result.engineId).toBe("engine-two");
      expect(result.html).toContain("Recovered by Engine 2");
      expect(loggedWarnings).toHaveLength(1);
      expect(loggedWarnings[0]).toContain("engine-one");
      expect(loggedWarnings[0]).toContain("https://example.com/post");
    });

    it("fails when all engines fail or engine list is empty", async () => {
      const failingEngine: ScraperEngine = {
        id: "only-engine",
        scrape: (url) =>
          Effect.fail(
            new FallbackScrapeError({
              engineId: "only-engine",
              url,
              reason: "upstream timeout",
            }),
          ),
      };

      const errAll = await Effect.runPromise(
        Effect.gen(function* () {
          const scraper = yield* FallbackScraper;
          return yield* scraper.scrape("https://example.com/1");
        }).pipe(
          Effect.provide(FallbackScraper.layerFromEngines([failingEngine])),
          Effect.flip,
        ),
      );
      expect(errAll).toBeInstanceOf(FallbackScrapeError);
      expect(errAll.engineId).toBe("only-engine");

      const errEmpty = await Effect.runPromise(
        Effect.gen(function* () {
          const scraper = yield* FallbackScraper;
          return yield* scraper.scrape("https://example.com/2");
        }).pipe(
          Effect.provide(FallbackScraper.layerFromEngines([])),
          Effect.flip,
        ),
      );
      expect(errEmpty).toBeInstanceOf(FallbackScrapeError);
    });

    it("bounds concurrent in-flight engine calls to concurrency limit", async () => {
      let currentInFlight = 0;
      let maxInFlight = 0;
      const twoStarted = Deferred.makeUnsafe<void>();
      const releaseGate = Deferred.makeUnsafe<void>();

      const gatedEngine: ScraperEngine = {
        id: "gated",
        scrape: (url) =>
          Effect.gen(function* () {
            currentInFlight++;
            maxInFlight = Math.max(maxInFlight, currentInFlight);
            if (currentInFlight === 2) {
              yield* Deferred.succeed(twoStarted, undefined);
            }
            yield* Deferred.await(releaseGate);
            currentInFlight--;
            return {
              engineId: "gated",
              url,
              html: "<html><head><title>OK</title></head></html>",
            };
          }),
      };

      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const scraper = yield* FallbackScraper;
          const batchFiber = yield* Effect.forEach(
            [
              "https://example.com/1",
              "https://example.com/2",
              "https://example.com/3",
              "https://example.com/4",
            ],
            (u) => scraper.scrape(u),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);

          yield* Deferred.await(twoStarted);
          expect(currentInFlight).toBe(2);
          yield* Deferred.succeed(releaseGate, undefined);
          return yield* Fiber.join(batchFiber);
        }).pipe(
          Effect.provide(FallbackScraper.layerFromEngines([gatedEngine], 2)),
        ),
      );

      expect(maxInFlight).toBe(2);
      expect(results).toHaveLength(4);
    });
  });
});
