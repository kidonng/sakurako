import { describe, expect, it } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  DEFAULT_JEV_MODEL,
  filterPreviewResults,
  OPENROUTER_SYSTEMONE_URL,
} from "../../../src/features/link-preview/JevFilter.ts";
import {
  HttpFetchError,
  type ScrapingResult,
} from "../../../src/features/link-preview/LinkPreview.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

function extractJsonBody(req: { body: unknown }): unknown {
  const body = req.body as { _tag?: string; body?: unknown };
  if (body && body._tag === "Uint8Array") {
    const raw =
      typeof body.body === "string"
        ? body.body
        : new TextDecoder().decode(body.body as Uint8Array);
    return JSON.parse(raw);
  }
  return null;
}

describe("filterPreviewResults", () => {
  it("skips filtering when apiKey is not provided", async () => {
    let called = false;
    const dummyLayer = makeTestHttpClient(() => {
      called = true;
      return new Response("", { status: 500 });
    });

    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test Title" },
      },
    ];

    const filtered = await Effect.runPromise(
      filterPreviewResults("some message", results, undefined).pipe(
        Effect.provide(dummyLayer),
      ),
    );

    expect(called).toBe(false);
    expect(filtered).toEqual(results);
  });

  it("skips filtering when no successful scrape results exist", async () => {
    let called = false;
    const dummyLayer = makeTestHttpClient(() => {
      called = true;
      return new Response("", { status: 500 });
    });

    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://fail.com",
        error: new HttpFetchError({ url: "https://fail.com", detail: "404" }),
      },
    ];

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "some message",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(dummyLayer)),
    );

    expect(called).toBe(false);
    expect(filtered).toEqual(results);
  });

  it("filters items below threshold 0.7 using OpenRouter System One", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.com",
          title: "News Title",
          description: "Full details not in user message",
        },
      },
      {
        _tag: "Success",
        data: {
          url: "https://t.me/promo",
          title: "Telegram Group",
          description: "Fast. Secure. Powerful.",
        },
      },
    ];

    const captured: {
      url?: string;
      method?: string;
      authHeader?: string | null;
      requestBody?: {
        model?: string;
        state?: {
          user_message?: string;
          previews?: Record<string, { url?: string; title?: string }>;
        };
        questions?: Record<string, { type?: string }>;
      };
    } = {};

    const layer = makeTestHttpClient((req) => {
      captured.url = req.url;
      captured.method = req.method;
      captured.authHeader = (req.headers["authorization"] ?? null) as
        | string
        | null;
      captured.requestBody = extractJsonBody(req) as typeof captured.requestBody;

      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.14",
          answers: {
            preview_0: { type: "noul", noul: 0.95 },
            preview_1: { type: "noul", noul: 0.12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "谷歌开放第三方安卓应用商店注册",
        results,
        Redacted.make("sk-or-test-key"),
      ).pipe(Effect.provide(layer)),
    );

    expect(captured.url).toBe(OPENROUTER_SYSTEMONE_URL);
    expect(captured.method).toBe("POST");
    expect(captured.authHeader).toBe("Bearer sk-or-test-key");
    expect(captured.requestBody?.model).toBe(DEFAULT_JEV_MODEL);
    expect(captured.requestBody?.state?.user_message).toBe(
      "谷歌开放第三方安卓应用商店注册",
    );
    expect(captured.requestBody?.state?.previews?.preview_0?.url).toBe(
      "https://news.com",
    );
    expect(captured.requestBody?.state?.previews?.preview_1?.url).toBe(
      "https://t.me/promo",
    );
    expect(captured.requestBody?.questions?.preview_0?.type).toBe("noul");
    expect(captured.requestBody?.questions?.preview_1?.type).toBe("noul");

    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toEqual(results[0]!);
    expect(filtered[1]).toEqual({
      _tag: "Filtered",
      url: "https://t.me/promo",
    });
  });

  it("preserves failure items and maps indexes correctly", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Failure",
        url: "https://fail.com",
        error: new HttpFetchError({ url: "https://fail.com", detail: "404" }),
      },
      {
        _tag: "Success",
        data: {
          url: "https://valid.com",
          title: "Valid Title",
        },
      },
    ];

    const layer = makeTestHttpClient((req) => {
      const body = extractJsonBody(req) as { questions: Record<string, unknown> };
      // Only one question should be generated for the one Success item
      expect(Object.keys(body.questions)).toEqual(["preview_1"]);

      return new Response(
        JSON.stringify({
          answers: {
            preview_1: { type: "noul", noul: 0.8 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "message",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(layer)),
    );

    expect(filtered[0]?._tag).toBe("Failure");
    expect(filtered[1]?._tag).toBe("Success");
  });

  it("falls back to original results when OpenRouter returns 500 error", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test" },
      },
    ];

    const failLayer = makeTestHttpClient(
      () => new Response("Server error", { status: 500 }),
    );

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "message",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(failLayer)),
    );

    expect(filtered).toEqual(results);
  });

  it("filters item when its answer key is missing from response", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test" },
      },
    ];

    const partialLayer = makeTestHttpClient(
      () =>
        new Response(
          JSON.stringify({
            answers: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "message",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(partialLayer)),
    );

    expect(filtered[0]?._tag).toBe("Filtered");
  });
});
