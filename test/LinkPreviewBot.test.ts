import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { Effect } from "effect";
import { handleLinkPreviewMessage } from "../src/LinkPreview.ts";
import type { IncomingMessage } from "../src/SnowLuma.ts";

describe("handleLinkPreviewMessage", () => {
  it("quotes reply when message contains valid link", async () => {
    let quotedMessage: unknown = null;
    const item: IncomingMessage = {
      event: {
        raw_message: "Please see https://example.com/test",
        message_type: "group",
        user_id: 10001,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async (msg: unknown) => {
          quotedMessage = msg;
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    const mockFetch = async () =>
      new Response(
        '<html><head><title>Preview Title</title><meta name="description" content="Preview Desc"></head></html>',
        { status: 200 },
      );

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );

    expect(quotedMessage).toBeDefined();
  });

  it("ignores self messages", async () => {
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        raw_message: "https://example.com",
        user_id: 99999,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true;
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    await Effect.runPromise(handleLinkPreviewMessage(item));
    expect(quoted).toBe(false);
  });

  it("ignores messages with message_sent post_type", async () => {
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        raw_message: "https://example.com",
        user_id: 10001,
        self_id: 99999,
        post_type: "message_sent",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true;
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    await Effect.runPromise(handleLinkPreviewMessage(item));
    expect(quoted).toBe(false);
  });

  it("ignores messages without links", async () => {
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        raw_message: "Hello world without any link",
        user_id: 10001,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true;
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    await Effect.runPromise(handleLinkPreviewMessage(item));
    expect(quoted).toBe(false);
  });

  it("remains silent when all links fail to scrape", async () => {
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        raw_message: "https://fail.com/404",
        user_id: 10001,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          quoted = true;
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    const mockFetch = async () => new Response("Not Found", { status: 404 });
    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );
    expect(quoted).toBe(false);
  });
});
