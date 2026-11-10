/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { handleSauceMessage } from "../../../src/features/sauce/Sauce.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";
import { createMockMessage } from "../../TestMessage.ts";

const mockSauceNaoSuccess = {
  header: {
    status: 0,
    minimum_similarity: 60.0,
  },
  results: [
    {
      header: {
        similarity: "88.00",
      },
      data: {
        title: "Test Art",
        member_name: "TestPainter",
        ext_urls: ["https://www.pixiv.net/artworks/99999"],
      },
    },
  ],
};

const dummyHttpLayer = makeTestHttpClient(() =>
  Response.json(mockSauceNaoSuccess),
);

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
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
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
    const httpLayer = makeTestHttpClient((req) => {
      searchedUrl = req.url;
      return Response.json(mockSauceNaoSuccess);
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
      handleSauceMessage(item).pipe(Effect.provide(httpLayer)),
    );

    expect(searchedUrl).toContain(
      "url=" + encodeURIComponent("https://example.com/first.jpg"),
    );
    expect(getReplies().length).toBe(1);
  });

  it("replies with notice when message is /sauce without a quote reply", async () => {
    const { item, getReplies } = createMockMessage({
      raw_message: "/sauce",
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
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
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[未在引用的消息中找到图片]");
  });

  it("replies with notice when SauceNao returns null (low similarity / no match)", async () => {
    const lowSimilarityLayer = makeTestHttpClient(() =>
      Response.json({
        header: {
          status: 0,
          minimum_similarity: 70.0,
        },
        results: [
          {
            header: {
              similarity: "45.00",
            },
            data: {
              title: "Low similarity",
            },
          },
        ],
      }),
    );

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
      handleSauceMessage(item).pipe(Effect.provide(lowSimilarityLayer)),
    );

    const replies = getReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("[未找到相似度较高的图片来源]");
  });

  it("replies with notice when SauceNao fails with an error", async () => {
    const errorLayer = makeTestHttpClient(
      () => new Response("Server error", { status: 500 }),
    );

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
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
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
        handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
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
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    expect(getReplies().length).toBe(0);
  });

  it("replies as a text segment preventing raw CQ code injection", async () => {
    const cpHackResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "99.00",
          },
          data: {
            title: "[CQ:at,qq=all] Dangerous Title",
            ext_urls: ["https://example.com/pic"],
          },
        },
      ],
    };

    const httpLayer = makeTestHttpClient(() => Response.json(cpHackResponse));

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
      handleSauceMessage(item).pipe(Effect.provide(httpLayer)),
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
