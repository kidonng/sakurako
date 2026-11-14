/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { handleImageGenMessage } from "../../../src/features/image-gen/ImageGen.ts";
import {
  ImageGenApiError,
  ImageGenClient,
  ImageGenConfigError,
} from "../../../src/features/image-gen/ImageGenClient.ts";
import {
  HttpNetworkError,
  HttpRateLimitError,
  HttpTimeoutError,
} from "../../../src/utils/HttpClient.ts";
import { createMockMessage } from "../../TestMessage.ts";

const ENABLED_ENV = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    OPENROUTER_API_KEY: "sk-test",
    OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
  }),
);

describe("handleImageGenMessage", () => {
  it("ignores self-sent messages (user_id === self_id and post_type === message_sent)", async () => {
    let called = false;
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: () => {
        called = true;
        return Effect.succeed("abc");
      },
    });

    const selfIdCase = createMockMessage({
      user_id: 999999,
      self_id: 999999,
      raw_message: "/gen cat",
    });
    const messageSentCase = createMockMessage({
      post_type: "message_sent",
      user_id: 10001,
      self_id: 999999,
      raw_message: "/gen cat",
    });

    for (const mock of [selfIdCase, messageSentCase]) {
      await Effect.runPromise(
        handleImageGenMessage(mock.item).pipe(
          Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
        ),
      );
      expect(mock.getReplies()).toEqual([]);
    }

    expect(called).toBe(false);
  });

  it("ignores unrelated messages", async () => {
    let called = false;
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: () => {
        called = true;
        return Effect.succeed("abc");
      },
    });

    for (const raw of ["hello", "/dbr cat", "/generate cat"]) {
      const mock = createMockMessage({ raw_message: raw });
      await Effect.runPromise(
        handleImageGenMessage(mock.item).pipe(
          Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
        ),
      );
      expect(mock.getReplies()).toEqual([]);
    }

    expect(called).toBe(false);
  });

  it("replies disabled notice when OPENROUTER_API_KEY or OPENROUTER_IMAGE_MODEL is missing", async () => {
    let called = false;
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: () => {
        called = true;
        return Effect.succeed("abc");
      },
    });

    for (const env of [
      {},
      { OPENROUTER_API_KEY: "sk-test" },
      { OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free" },
      { OPENROUTER_API_KEY: "  ", OPENROUTER_IMAGE_MODEL: "  " },
    ]) {
      for (const raw of ["/gen cat", "/gen"]) {
        const mock = createMockMessage({ raw_message: raw });
        await Effect.runPromise(
          handleImageGenMessage(mock.item).pipe(
            Effect.provide(
              Layer.merge(
                clientMock,
                ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
              ),
            ),
          ),
        );
        expect(mock.lastReply()).toBe("[生图功能未启用]");
      }
    }

    expect(called).toBe(false);
  });

  it("replies usage hint listing all supported ratios when prompt is empty", async () => {
    let called = false;
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: () => {
        called = true;
        return Effect.succeed("abc");
      },
    });

    for (const raw of ["/gen", "/gen   ", "/gen 16:9", "/gen 16：9  "]) {
      const mock = createMockMessage({ raw_message: raw });
      await Effect.runPromise(
        handleImageGenMessage(mock.item).pipe(
          Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
        ),
      );
      expect(mock.lastReply()).toBe(
        "[请输入提示词，例如：/gen 16:9 一只橘猫（支持比例：1:1、4:3、3:4、16:9、9:16）]",
      );
    }

    expect(called).toBe(false);
  });

  it("strips leading @mention/reply, passes prompt & ratio, and replies with base64 image", async () => {
    const calls: Array<{ prompt: string; aspectRatio?: string }> = [];
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: (prompt, aspectRatio) => {
        calls.push({ prompt, aspectRatio });
        return Effect.succeed("iVBORw0KGgoAAAANSUhEUg==");
      },
    });

    const mock = createMockMessage({
      self_id: 999999,
      message: [
        { type: "reply", data: { id: "42" } },
        { type: "at", data: { qq: "999999" } },
        { type: "text", data: { text: " /gen 16：9 一只戴墨镜的橘猫 " } },
      ],
    });

    await Effect.runPromise(
      handleImageGenMessage(mock.item).pipe(
        Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
      ),
    );

    expect(calls).toEqual([
      { prompt: "一只戴墨镜的橘猫", aspectRatio: "16:9" },
    ]);
    expect(mock.lastReply()).toEqual({
      type: "image",
      data: { file: "base64://iVBORw0KGgoAAAANSUhEUg==" },
    });
  });

  it("maps config, rate-limit, and API/network errors to Chinese replies", async () => {
    const cases = [
      {
        error: new ImageGenConfigError(),
        expected: "[生图功能未启用]",
      },
      {
        error: new HttpRateLimitError({
          url: "https://openrouter.ai/api/v1/images",
          status: 429,
          detail: "rate limited",
        }),
        expected: "[生图请求过于频繁，请稍后再试]",
      },
      {
        error: new ImageGenApiError({ detail: "empty data" }),
        expected: "[生图失败]",
      },
      {
        error: new HttpTimeoutError({
          url: "https://openrouter.ai/api/v1/images",
          detail: "timeout",
        }),
        expected: "[生图失败]",
      },
      {
        error: new HttpNetworkError({
          url: "https://openrouter.ai/api/v1/images",
          status: 500,
          detail: "500",
        }),
        expected: "[生图失败]",
      },
    ];

    for (const testCase of cases) {
      const clientMock = Layer.succeed(ImageGenClient, {
        generateImage: () => Effect.fail(testCase.error),
      });
      const mock = createMockMessage({ raw_message: "/gen cat" });

      await Effect.runPromise(
        handleImageGenMessage(mock.item).pipe(
          Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
        ),
      );

      expect(mock.lastReply()).toBe(testCase.expected);
    }
  });

  it("isolates reply failures without rejecting the handler effect", async () => {
    const clientMock = Layer.succeed(ImageGenClient, {
      generateImage: () => Effect.succeed("YWJj"),
    });
    const mock = createMockMessage({
      raw_message: "/gen cat",
      replyError: new Error("WebSocket closed"),
    });

    await Effect.runPromise(
      handleImageGenMessage(mock.item).pipe(
        Effect.provide(Layer.merge(clientMock, ENABLED_ENV)),
      ),
    );

    expect(mock.getReplies()).toEqual([
      { type: "image", data: { file: "base64://YWJj" } },
    ]);
  });
});
