/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpBody } from "effect/http";
import {
  ImageGenApiError,
  ImageGenClient,
  ImageGenConfigError,
  OPENROUTER_IMAGES_URL,
} from "../../../src/features/image-gen/ImageGenClient.ts";
import {
  HttpNetworkError,
  HttpRateLimitError,
} from "../../../src/utils/HttpClient.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

function extractJsonBody(req: { body: unknown }): Record<string, unknown> {
  // oxlint-disable-next-line effecttsgo/unstable-api-usage
  if (req.body instanceof HttpBody.Uint8Array) {
    return JSON.parse(new TextDecoder().decode(req.body.body)) as Record<
      string,
      unknown
    >;
  }
  return {};
}

describe("ImageGenClient", () => {
  it("posts prompt without aspect_ratio when omitted and returns raw b64_json", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedAuth: string | undefined;
    let capturedBody: Record<string, unknown> = {};

    const httpLayer = makeTestHttpClient((req) => {
      capturedUrl = req.url;
      capturedMethod = req.method;
      capturedAuth = req.headers["authorization"];
      capturedBody = extractJsonBody(req);
      return new Response(
        JSON.stringify({
          created: 1748372400,
          data: [{ b64_json: "iVBORw0KGgo=", media_type: "image/png" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* ImageGenClient;
        return yield* client.generateImage("an orange cat");
      }).pipe(
        Effect.provide(
          ImageGenClient.layer.pipe(
            Layer.provide(Layer.merge(httpLayer, configLayer)),
          ),
        ),
      ),
    );

    expect(capturedUrl).toBe(OPENROUTER_IMAGES_URL);
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer sk-test");
    expect(capturedBody).toEqual({
      model: "recraft/recraft-v4.1-flash-v2:free",
      prompt: "an orange cat",
    });
    expect("aspect_ratio" in capturedBody).toBe(false);
    expect(result).toBe("iVBORw0KGgo=");
  });

  it("includes aspect_ratio when specified and strips data URI prefix", async () => {
    let capturedBody: Record<string, unknown> = {};

    const httpLayer = makeTestHttpClient((req) => {
      capturedBody = extractJsonBody(req);
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: "data:image/png;base64,aGVsbG8=",
              media_type: "image/png",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* ImageGenClient;
        return yield* client.generateImage("cyberpunk cityscape", "16:9");
      }).pipe(
        Effect.provide(
          ImageGenClient.layer.pipe(
            Layer.provide(Layer.merge(httpLayer, configLayer)),
          ),
        ),
      ),
    );

    expect(capturedBody).toEqual({
      model: "recraft/recraft-v4.1-flash-v2:free",
      prompt: "cyberpunk cityscape",
      aspect_ratio: "16:9",
    });
    expect(result).toBe("aGVsbG8=");
  });

  it("fails with ImageGenConfigError without HTTP calls when key or model is missing", async () => {
    let httpCalled = false;
    const httpLayer = makeTestHttpClient(() => {
      httpCalled = true;
      return new Response("", { status: 500 });
    });

    for (const env of [
      { OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free" },
      { OPENROUTER_API_KEY: "sk-test" },
      { OPENROUTER_API_KEY: "   ", OPENROUTER_IMAGE_MODEL: "  " },
    ]) {
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(env),
      );
      const err = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* ImageGenClient;
          return yield* client.generateImage("cat");
        }).pipe(
          Effect.provide(
            ImageGenClient.layer.pipe(
              Layer.provide(Layer.merge(httpLayer, configLayer)),
            ),
          ),
          Effect.flip,
        ),
      );

      expect(err).toBeInstanceOf(ImageGenConfigError);
      expect(err._tag).toBe("ImageGenConfigError");
    }

    expect(httpCalled).toBe(false);
  });

  it("passes through HttpRateLimitError on 429 and HttpNetworkError on 500", async () => {
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );

    const layer429 = makeTestHttpClient(
      () => new Response("rate limit", { status: 429 }),
    );
    const err429 = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* ImageGenClient;
        return yield* client.generateImage("cat");
      }).pipe(
        Effect.provide(
          ImageGenClient.layer.pipe(
            Layer.provide(Layer.merge(layer429, configLayer)),
          ),
        ),
        Effect.flip,
      ),
    );
    expect(err429).toBeInstanceOf(HttpRateLimitError);
    expect(err429._tag).toBe("HttpRateLimitError");

    const layer500 = makeTestHttpClient(
      () => new Response("server error", { status: 500 }),
    );
    const err500 = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* ImageGenClient;
        return yield* client.generateImage("cat");
      }).pipe(
        Effect.provide(
          ImageGenClient.layer.pipe(
            Layer.provide(Layer.merge(layer500, configLayer)),
          ),
        ),
        Effect.flip,
      ),
    );
    expect(err500).toBeInstanceOf(HttpNetworkError);
    expect(err500._tag).toBe("HttpNetworkError");
  });

  it("fails with ImageGenApiError on empty data, missing b64_json, or SVG output", async () => {
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        OPENROUTER_API_KEY: "sk-test",
        OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );

    for (const payload of [
      { data: [] },
      { data: [{ b64_json: "   ", media_type: "image/png" }] },
      { data: [{ media_type: "image/png" }] },
      { data: [{ b64_json: "PHN2Zz4=", media_type: "image/svg+xml" }] },
    ]) {
      const httpLayer = makeTestHttpClient(
        () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      const err = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* ImageGenClient;
          return yield* client.generateImage("cat");
        }).pipe(
          Effect.provide(
            ImageGenClient.layer.pipe(
              Layer.provide(Layer.merge(httpLayer, configLayer)),
            ),
          ),
          Effect.flip,
        ),
      );

      expect(err).toBeInstanceOf(ImageGenApiError);
      expect(err._tag).toBe("ImageGenApiError");
    }
  });
});
