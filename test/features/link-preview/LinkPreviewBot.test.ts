import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { HttpBody } from "effect/http";
import { handleLinkPreviewMessage } from "../../../src/features/link-preview/LinkPreview.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";
import { createMockMessage } from "../../TestMessage.ts";

const dummyLayer = makeTestHttpClient(() => new Response(""));

describe("handleLinkPreviewMessage", () => {
  it("ignores self messages", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "https://example.com",
      user_id: 99999,
      self_id: 99999,
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(dummyLayer)),
    );
    expect(getReplies().length).toBe(0);
  });

  it("ignores messages without links", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "Hello world without any link",
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(dummyLayer)),
    );
    expect(getReplies().length).toBe(0);
  });

  it("ignores messages that only contain CQ image codes with URLs", async () => {
    let fetchCalled = false;
    const { item, getReplies } = createMockMessage({
      raw_message:
        "[CQ:image,file=0D09E17787BF2D57986E4271AA599A6D.jpg,url=https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=test]",
    });

    const layer = makeTestHttpClient(() => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
    );
    expect(fetchCalled).toBe(false);
    expect(getReplies().length).toBe(0);
  });

  it("remains silent when all links fail to scrape", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "https://fail.com/404",
    });

    const layer = makeTestHttpClient(
      () => new Response("Not Found", { status: 404 }),
    );
    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
    );
    expect(getReplies().length).toBe(0);
  });

  it("replies with only image segment for single github.com link with image", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "https://github.com/kidonng/sakurako",
    });

    const githubHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>kidonng/sakurako</title>
          <meta name="description" content="A QQ bot">
          <meta property="og:image" content="https://opengraph.githubassets.com/repo/kidonng/sakurako">
        </head>
        <body>GitHub</body>
      </html>
    `;
    const mockImageBytes = new Uint8Array([1, 2, 3]);
    const layer = makeTestHttpClient((req) => {
      if (req.url.includes("opengraph.githubassets.com")) {
        return new Response(mockImageBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response(githubHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
    );

    expect(lastReply()).toEqual([
      {
        type: "image",
        data: {
          file: "base64://" + Buffer.from(mockImageBytes).toString("base64"),
        },
      },
    ]);
  });

  it("logs the failed URL and error details when sending link preview reply fails", async () => {
    const loggedMessages: string[] = [];
    const testLogger = Logger.make((options) => {
      if (options.logLevel === "Error") {
        const msg = Array.isArray(options.message)
          ? options.message.map(String).join(" ")
          : String(options.message);
        loggedMessages.push(msg);
      }
    });

    const { item } = createMockMessage({
      raw_message: "https://news.ycombinator.com/item?id=50261319",
      replyError: new Error("OneBot API failed to send media"),
    });

    const layer = makeTestHttpClient(
      () =>
        new Response(
          '<html><head><title>Preview Title</title><meta name="description" content="Preview Desc"></head></html>',
          { status: 200 },
        ),
    );

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(layer, Logger.layer([testLogger]))),
      ),
    );

    expect(loggedMessages.length).toBe(1);
    expect(loggedMessages[0]).toContain(
      "https://news.ycombinator.com/item?id=50261319",
    );
    expect(loggedMessages[0]).toContain("OneBot API failed to send media");
    expect(loggedMessages[0]).not.toContain("UnknownError");
  });

  it("replies with text-only reply for Hacker News item containing y18.svg", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "https://news.ycombinator.com/item?id=50261319",
    });

    const hnHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Genie 4 | Hacker News</title></head>
        <body>
          <img src="y18.svg" width="18" height="18">
          <span class="titleline">
            <a href="https://deepmind.google/blog/genie-4">Genie 4</a>
          </span>
        </body>
      </html>
    `;
    const layer = makeTestHttpClient(
      () => new Response(hnHtml, { status: 200 }),
    );

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
    );

    expect(lastReply()).toEqual({
      type: "text",
      data: {
        text: "Genie 4 | Hacker News\n> https://deepmind.google/blog/genie-4",
      },
    });
  });

  it("falls back to text-only reply when reply with image fails", async () => {
    let attempt = 0;
    const { item, getReplies } = createMockMessage({
      raw_message: "https://example.com/with-image",
      onReply: () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("HTTP download failed: 403");
        }
        return { message_id: 12345 };
      },
    });

    const layer = makeTestHttpClient((req) => {
      if (req.url.includes("cover.png")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response(
        '<html><head><title>Title</title><meta property="og:image" content="https://example.com/cover.png"></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(Effect.provide(layer)),
    );

    const repliesAttempted = getReplies();
    expect(repliesAttempted.length).toBe(2);
    // First attempt included image segment
    expect(Array.isArray(repliesAttempted[0])).toBe(true);
    expect(
      (repliesAttempted[0] as Array<{ type: string }>).some(
        (s) => s.type === "image",
      ),
    ).toBe(true);
    // Second attempt was text-only
    expect(repliesAttempted[1]).toEqual({
      type: "text",
      data: {
        text: "Title",
      },
    });
  });

  it("silences reply when single link preview is filtered by decision model", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "Please see https://example.com/test",
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://localhost:3001",
        SNOWLUMA_ACCESS_TOKEN: "token",
        OPENROUTER_API_KEY: "test_key",
      }),
    );

    const httpLayer = makeTestHttpClient((req) => {
      if (req.url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            answers: {
              preview_0: { type: "noul", noul: 0.15 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        "<html><head><title>Preview Title</title></head></html>",
        { status: 200 },
      );
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(httpLayer, configLayer)),
      ),
    );

    expect(getReplies().length).toBe(0);
  });

  it("outputs placeholder when one of multiple links is filtered by decision model", async () => {
    const { item, lastReply } = createMockMessage({
      raw_message: "Check https://example.com/one and https://example.com/two",
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://localhost:3001",
        SNOWLUMA_ACCESS_TOKEN: "token",
        OPENROUTER_API_KEY: "test_key",
      }),
    );

    const httpLayer = makeTestHttpClient((req) => {
      if (req.url.includes("openrouter.ai")) {
        return new Response(
          JSON.stringify({
            answers: {
              preview_0: { type: "noul", noul: 0.2 },
              preview_1: { type: "noul", noul: 0.9 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (req.url.includes("/one")) {
        return new Response(
          "<html><head><title>Title One</title></head></html>",
          { status: 200 },
        );
      }
      return new Response(
        "<html><head><title>Title Two</title></head></html>",
        { status: 200 },
      );
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(httpLayer, configLayer)),
      ),
    );

    const reply = lastReply();
    expect(reply).toBeDefined();
    const textSegment = reply as {
      type: string;
      data: { text: string };
    };
    expect(textSegment.data.text).toBe("1. [已过滤]\n2. Title Two");
  });

  it("passes OPENROUTER_DECISION_MODEL to decision filter request when configured", async () => {
    let capturedModel: string | undefined;

    const { item } = createMockMessage({
      raw_message: "Please see https://example.com/test",
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://localhost:3001",
        SNOWLUMA_ACCESS_TOKEN: "token",
        OPENROUTER_API_KEY: "test_key",
        OPENROUTER_DECISION_MODEL: "openai/gpt-6-luna-decisions",
      }),
    );

    const httpLayer = makeTestHttpClient((req) => {
      if (req.url.includes("openrouter.ai")) {
        const raw =
          // oxlint-disable-next-line effecttsgo/unstable-api-usage
          req.body instanceof HttpBody.Uint8Array
            ? new TextDecoder().decode(req.body.body)
            : "{}";
        const body = JSON.parse(raw) as { model?: string };
        capturedModel = body.model;
        return new Response(
          JSON.stringify({
            answers: {
              preview_0: { type: "noul", noul: 0.9 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        "<html><head><title>Preview Title</title></head></html>",
        { status: 200 },
      );
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(httpLayer, configLayer)),
      ),
    );

    expect(capturedModel).toBe("openai/gpt-6-luna-decisions");
  });

  it("does not contact OpenRouter when OPENROUTER_API_KEY is omitted", async () => {
    let openrouterContacted = false;

    const { item, lastReply } = createMockMessage({
      raw_message: "Please see https://example.com/test",
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://localhost:3001",
        SNOWLUMA_ACCESS_TOKEN: "token",
      }),
    );

    const httpLayer = makeTestHttpClient((req) => {
      if (req.url.includes("openrouter.ai")) {
        openrouterContacted = true;
        return new Response("", { status: 500 });
      }
      return new Response(
        "<html><head><title>Unfiltered Title</title></head></html>",
        { status: 200 },
      );
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(httpLayer, configLayer)),
      ),
    );

    expect(openrouterContacted).toBe(false);
    const reply = lastReply();
    expect(reply).toBeDefined();
    const textSegment = reply as {
      type: string;
      data: { text: string };
    };
    expect(textSegment.data.text).toBe("Unfiltered Title");
  });

  it("extracts user images, sanitizes CQ codes, and sends multimodal state to OpenRouter Decisions", async () => {
    const capturedBody: { value?: { state?: unknown } } = {};
    const rawPng = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://localhost:3001",
        SNOWLUMA_ACCESS_TOKEN: "token",
        OPENROUTER_API_KEY: "test-openrouter-key",
      }),
    );

    const httpLayer = makeTestHttpClient((req) => {
      if (req.url.includes("openrouter.ai")) {
        // oxlint-disable-next-line effecttsgo/unstable-api-usage
        if (req.body instanceof HttpBody.Uint8Array) {
          const raw = new TextDecoder().decode(req.body.body);
          capturedBody.value = JSON.parse(raw);
        }
        return new Response(
          JSON.stringify({
            answers: {
              preview_0: { type: "noul", noul: 0.9 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        '<html><head><title>Scraped Title</title><meta name="description" content="Scraped Desc"></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    });

    const { item } = createMockMessage({
      raw_message:
        "see this https://example.com/incident [CQ:image,file=screenshot.png]",
      message: [
        {
          type: "text",
          data: { text: "see this https://example.com/incident " },
        },
        { type: "image", data: { file: "screenshot.png" } },
      ],
      client: {
        downloadFileStream: async function* () {
          yield rawPng;
        },
      },
    });

    await Effect.runPromise(
      handleLinkPreviewMessage(item).pipe(
        Effect.provide(Layer.merge(httpLayer, configLayer)),
      ),
    );

    expect(capturedBody.value).toBeDefined();
    const state = capturedBody.value?.state as Array<Record<string, unknown>>;
    expect(Array.isArray(state)).toBe(true);
    expect(state).toHaveLength(2);
    expect(state[0]?.user_message).toBe(
      "see this https://example.com/incident [图片]",
    );
    expect(state[1]?.type).toBe("image_url");
    const imgPart = state[1]?.image_url as { url: string };
    expect(imgPart.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});
