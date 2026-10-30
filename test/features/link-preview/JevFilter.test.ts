import { describe, expect, it } from "bun:test";
import { Effect, Layer, Logger, Redacted } from "effect";
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
        string | null;
      captured.requestBody = extractJsonBody(
        req,
      ) as typeof captured.requestBody;

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
    const firstItem = results[0] as Extract<
      ScrapingResult,
      { _tag: "Success" }
    >;
    expect(filtered[0]).toEqual({
      _tag: "Success",
      data: firstItem.data,
      expanded: false,
    });
    expect(filtered[1]).toEqual({
      _tag: "Filtered",
      url: "https://t.me/promo",
    });
  });

  it("logs filtered URL and score when an item is filtered, without logging for passing items", async () => {
    const loggedMessages: Array<{ level: string; message: string }> = [];
    const testLogger = Logger.make((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.map(String).join(" ")
        : String(options.message);
      loggedMessages.push({ level: options.logLevel, message: msg });
    });

    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.com",
          title: "News Title",
        },
      },
      {
        _tag: "Success",
        data: {
          url: "https://t.me/promo",
          title: "Telegram Promo",
        },
      },
    ];

    const layer = makeTestHttpClient(() => {
      return new Response(
        JSON.stringify({
          answers: {
            preview_0: { type: "noul", noul: 0.95 },
            preview_1: { type: "noul", noul: 0.12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await Effect.runPromise(
      filterPreviewResults(
        "some user message",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(Layer.merge(layer, Logger.layer([testLogger])))),
    );

    const infoLogs = loggedMessages.filter((l) => l.level === "Info");
    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]?.message).toContain("https://t.me/promo");
    expect(infoLogs[0]?.message).toContain("0.12");

    const passedLogs = loggedMessages.filter((l) =>
      l.message.includes("https://news.com"),
    );
    expect(passedLogs).toHaveLength(0);
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
      const body = extractJsonBody(req) as {
        questions: Record<string, unknown>;
      };
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
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(layer),
      ),
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
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(failLayer),
      ),
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
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(partialLayer),
      ),
    );

    expect(filtered[0]?._tag).toBe("Filtered");
  });

  it("falls back to original results when OpenRouter returns 429 rate limit", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test" },
      },
    ];

    const rateLimitLayer = makeTestHttpClient(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );

    const filtered = await Effect.runPromise(
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(rateLimitLayer),
      ),
    );

    expect(filtered).toEqual(results);
  });

  it("falls back to original results when OpenRouter response body is null or lacks answers", async () => {
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: { url: "https://example.com", title: "Test" },
      },
    ];

    const nullLayer = makeTestHttpClient(
      () =>
        new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const filteredNull = await Effect.runPromise(
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(nullLayer),
      ),
    );
    expect(filteredNull).toEqual(results);

    const noAnswersLayer = makeTestHttpClient(
      () =>
        new Response(JSON.stringify({ model: "typesafe/jev" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const filteredNoAnswers = await Effect.runPromise(
      filterPreviewResults("message", results, Redacted.make("sk-test")).pipe(
        Effect.provide(noAnswersLayer),
      ),
    );
    expect(filteredNoAnswers).toEqual(results);
  });

  it("requests standard_is_sufficient and marks expanded: true when standard is insufficient", async () => {
    const longDesc =
      "数字资产硬件钱包公司 Ballet Global 创始人 Bobby Lee 在彭博电视采访中表示，币安被盗比特币大概率无法追回，冻结资产不等于成功追回，仅稳定币仍有追回可能。目前币安已暂停充提并承诺全额赔付，约 30 亿美元涉案资产被冻结，但比特币市场未现大幅抛售。#币安被盗##加密货币#";
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.com/binance",
          title: "币安被盗事件追踪",
          description: longDesc,
        },
      },
    ];

    type CapturedPayload = {
      state?: {
        previews?: Record<string, { standard_truncated?: string }>;
      };
      questions?: Record<string, unknown>;
    };
    const captured: { body?: CapturedPayload } = {};
    const layer = makeTestHttpClient((req) => {
      captured.body = extractJsonBody(req) as CapturedPayload;
      return new Response(
        JSON.stringify({
          answers: {
            preview_0: { type: "noul", noul: 0.9 },
            preview_0_standard_is_sufficient: { type: "noul", noul: 0.2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "Bobby Lee认为币安被盗比特币大概率无法追回",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(layer)),
    );

    expect(
      captured.body?.state?.previews?.preview_0?.standard_truncated,
    ).toBeDefined();
    expect(
      captured.body?.questions?.preview_0_standard_is_sufficient,
    ).toBeDefined();
    expect(filtered).toHaveLength(1);
    const first = results[0] as Extract<ScrapingResult, { _tag: "Success" }>;
    expect(filtered[0]).toEqual({
      _tag: "Success",
      data: first.data,
      expanded: true,
    });
  });

  it("marks expanded: false when standard_is_sufficient is above threshold", async () => {
    const longDesc =
      "数字资产硬件钱包公司 Ballet Global 创始人 Bobby Lee 在彭博电视采访中表示，币安被盗比特币大概率无法追回，冻结资产不等于成功追回，仅稳定币仍有追回可能。目前币安已暂停充提并承诺全额赔付，约 30 亿美元涉案资产被冻结，但比特币市场未现大幅抛售。#币安被盗##加密货币#";
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.com/binance",
          title: "币安被盗事件追踪",
          description: longDesc,
        },
      },
    ];

    const layer = makeTestHttpClient(() => {
      return new Response(
        JSON.stringify({
          answers: {
            preview_0: { type: "noul", noul: 0.95 },
            preview_0_standard_is_sufficient: { type: "noul", noul: 0.85 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults(
        "用户仅发送了链接",
        results,
        Redacted.make("sk-test"),
      ).pipe(Effect.provide(layer)),
    );

    expect(filtered).toHaveLength(1);
    const first = results[0] as Extract<ScrapingResult, { _tag: "Success" }>;
    expect(filtered[0]).toEqual({
      _tag: "Success",
      data: first.data,
      expanded: false,
    });
  });

  it("skips standard_is_sufficient question when description is short (<= 100 width)", async () => {
    const shortDesc = "简短摘要内容";
    const results: ScrapingResult[] = [
      {
        _tag: "Success",
        data: {
          url: "https://news.com/short",
          title: "简短新闻",
          description: shortDesc,
        },
      },
    ];

    const captured: { body?: { questions?: Record<string, unknown> } } = {};
    const layer = makeTestHttpClient((req) => {
      captured.body = extractJsonBody(req) as {
        questions?: Record<string, unknown>;
      };
      return new Response(
        JSON.stringify({
          answers: {
            preview_0: { type: "noul", noul: 0.9 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const filtered = await Effect.runPromise(
      filterPreviewResults("用户消息", results, Redacted.make("sk-test")).pipe(
        Effect.provide(layer),
      ),
    );
    expect(captured.body?.questions?.preview_0).toBeDefined();
    expect(
      captured.body?.questions?.preview_0_standard_is_sufficient,
    ).toBeUndefined();
    const first = results[0] as Extract<ScrapingResult, { _tag: "Success" }>;
    expect(filtered[0]).toEqual({
      _tag: "Success",
      data: first.data,
      expanded: false,
    });
  });
});
