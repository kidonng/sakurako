/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { Effect } from "effect";
import { handleSauceMessage } from "../../../src/features/sauce/Sauce.ts";
import type { IncomingMessage } from "../../../src/SnowLuma.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

function createMockItem(params: {
  raw_message: string;
  message?: unknown;
  post_type?: "message" | "message_sent";
  user_id?: number;
  self_id?: number;
  getMessageResponse?: unknown;
  getMessageError?: boolean;
}): { item: IncomingMessage; getQuotedReplies: () => unknown[] } {
  const quotedReplies: unknown[] = [];

  const item: IncomingMessage = {
    event: {
      raw_message: params.raw_message,
      message: params.message ?? params.raw_message,
      post_type: params.post_type ?? "message",
      message_type: "group",
      user_id: params.user_id ?? 10001,
      self_id: params.self_id ?? 99999,
    } as unknown as OneBotMessageEvent,
    context: {
      client: {
        getMessage: async (_id: number) => {
          if (params.getMessageError) {
            throw new Error("OneBot get_msg error");
          }
          return (params.getMessageResponse ?? {
            message: [],
          }) as Record<string, unknown>;
        },
      },
      quote: async (msg: unknown) => {
        quotedReplies.push(msg);
      },
    } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
  };

  return {
    item,
    getQuotedReplies: () => quotedReplies,
  };
}

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
  it("quotes reply with formatted text when quoting a message with an image", async () => {
    const { item, getQuotedReplies } = createMockItem({
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

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe(
      "Test Art by TestPainter\nhttps://www.pixiv.net/artworks/99999",
    );
  });

  it("extracts and searches the first image when quoted message has multiple images", async () => {
    let searchedUrl = "";
    const httpLayer = makeTestHttpClient((req) => {
      searchedUrl = req.url;
      return Response.json(mockSauceNaoSuccess);
    });

    const { item, getQuotedReplies } = createMockItem({
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
    expect(getQuotedReplies().length).toBe(1);
  });

  it("triggers search in group chat when message contains auto-prepended @author segment", async () => {
    const { item, getQuotedReplies } = createMockItem({
      raw_message: "[CQ:reply,id=12345][CQ:at,qq=10002] /sauce",
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
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("Test Art");
  });

  it("quotes reply with notice when message is /sauce without a quote reply", async () => {
    const { item, getQuotedReplies } = createMockItem({
      raw_message: "/sauce",
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("未在引用的消息中找到图片");
  });

  it("quotes reply with notice when quoted message has no image", async () => {
    const { item, getQuotedReplies } = createMockItem({
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

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("未在引用的消息中找到图片");
  });

  it("quotes reply with notice when SauceNao returns null (low similarity / no match)", async () => {
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

    const { item, getQuotedReplies } = createMockItem({
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

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("未找到相似度较高的图片来源");
  });

  it("quotes reply with notice when SauceNao fails with an error", async () => {
    const errorLayer = makeTestHttpClient(
      () => new Response("Server error", { status: 500 }),
    );

    const { item, getQuotedReplies } = createMockItem({
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

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("查询失败，请稍后重试");
  });

  it("quotes reply with notice when getMessage fails with an error", async () => {
    const { item, getQuotedReplies } = createMockItem({
      raw_message: "[CQ:reply,id=12345] /sauce",
      getMessageError: true,
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    const replies = getQuotedReplies();
    expect(replies.length).toBe(1);
    expect(replies[0]).toBe("查询失败，请稍后重试");
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
      const { item, getQuotedReplies } = createMockItem({
        raw_message: msg,
      });

      await Effect.runPromise(
        handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
      );

      expect(getQuotedReplies().length).toBe(0);
    }
  });

  it("does nothing when message is sent by the bot itself", async () => {
    const { item, getQuotedReplies } = createMockItem({
      raw_message: "[CQ:reply,id=12345] /sauce",
      user_id: 99999,
      self_id: 99999,
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    expect(getQuotedReplies().length).toBe(0);
  });

  it("does nothing when post_type is message_sent", async () => {
    const { item, getQuotedReplies } = createMockItem({
      raw_message: "[CQ:reply,id=12345] /sauce",
      post_type: "message_sent",
    });

    await Effect.runPromise(
      handleSauceMessage(item).pipe(Effect.provide(dummyHttpLayer)),
    );

    expect(getQuotedReplies().length).toBe(0);
  });
});
