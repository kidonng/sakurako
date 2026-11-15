/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { handleSauceMessage } from "../../../src/features/sauce/Sauce.ts";
import {
  SauceNaoClient,
  SauceNaoError,
  type SauceResult,
} from "../../../src/features/sauce/SauceNao.ts";
import { createMockMessage } from "../../TestMessage.ts";

const mockSauceResult: SauceResult = {
  title: "Test Art",
  author: "TestPainter",
  url: "https://www.pixiv.net/artworks/99999",
  formattedText:
    "Test Art by TestPainter\nhttps://www.pixiv.net/artworks/99999",
  similarity: 88.0,
};

const dummyClientLayer = Layer.succeed(SauceNaoClient, {
  search: () => Effect.succeed(mockSauceResult),
});

describe("handleSauceMessage", () => {
  it("replies with formatted text when quoting a message with an image", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "image",
            data: {
              url: "https://example.com/target.jpg",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toEqual({
      type: "text",
      data: {
        text: "Test Art by TestPainter\nhttps://www.pixiv.net/artworks/99999",
      },
    });
  });

  it("extracts and searches the first image when quoted message has multiple images", async () => {
    let searchedUrl = "";
    const clientLayer = Layer.succeed(SauceNaoClient, {
      search: (imageUrl) => {
        searchedUrl = imageUrl;
        return Effect.succeed(mockSauceResult);
      },
    });
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "image",
            data: {
              url: "https://example.com/first.jpg",
            },
          },
          {
            type: "image",
            data: {
              url: "https://example.com/second.jpg",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(clientLayer)),
    );

    expect(searchedUrl).toBe("https://example.com/first.jpg");
    expect(getReplies().length).toBe(1);
  });

  it("replies with notice when message is /sauce without a quote reply", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "/sauce",
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[需引用包含图片的消息]");
  });

  it("replies with notice when quoted message has no image", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "text",
            data: {
              text: "just text without image",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[未在引用的消息中找到图片]");
  });

  it("replies with notice when SauceNao returns null (low similarity / no match)", async () => {
    const nullResultLayer = Layer.succeed(SauceNaoClient, {
      search: () => Effect.succeed(null),
    });
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "image",
            data: {
              url: "https://example.com/target.jpg",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(nullResultLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[未找到相似度较高的图片来源]");
  });

  it("replies with notice when SauceNao fails with an error", async () => {
    const errorLayer = Layer.succeed(SauceNaoClient, {
      search: () =>
        Effect.fail(
          new SauceNaoError({ cause: "SauceNao HTTP returned status 500" }),
        ),
    });
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "image",
            data: {
              url: "https://example.com/target.jpg",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(errorLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[查询失败]");
  });

  it("replies with notice when getMessage fails with an error", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageError: true,
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[查询失败]");
  });

  it("does nothing when message does not strictly match /sauce", async () => {
    const tests = [
      "sauce",
      "/sauce help",
      "/sauce 123",
      "[CQ:reply,id=12345] /sauce extra",
      "[CQ:face,id=1] /sauce",
    ];

    for (const msg of tests) {
      const { item, getReplies } = createMockMessage({
        raw_message: msg,
      });

      await Effect.runPromise(
        handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
      );

      expect(getReplies().length).toBe(0);
    }
  });

  it("does nothing when message is sent by the bot itself", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      user_id: 99999,
      self_id: 99999,
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyClientLayer)),
    );

    expect(getReplies().length).toBe(0);
  });

  it("replies as a text segment preventing raw CQ code injection", async () => {
    const cqInjectionLayer = Layer.succeed(SauceNaoClient, {
      search: () =>
        Effect.succeed({
          title: "[CQ:at,qq=all] Dangerous Title",
          url: "https://example.com/pic",
          formattedText:
            "[CQ:at,qq=all] Dangerous Title\nhttps://example.com/pic",
          similarity: 99.0,
        }),
    });
    const { item, getReplies } = createMockMessage({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageResponse: {
        message: [
          {
            type: "image",
            data: {
              url: "https://example.com/pic.jpg",
            },
          },
        ],
      },
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(cqInjectionLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toEqual({
      type: "text",
      data: {
        text: "[CQ:at,qq=all] Dangerous Title\nhttps://example.com/pic",
      },
    });
  });
});
