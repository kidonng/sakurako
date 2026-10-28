import { describe, expect, it } from "bun:test";
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk";
import type { OneBotMessageEvent } from "@snowluma/sdk/types";
import { Effect, Logger } from "effect";
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

  it("ignores messages that only contain CQ image codes with URLs", async () => {
    let fetchCalled = false;
    let quoted = false;
    const item: IncomingMessage = {
      event: {
        raw_message:
          "[CQ:image,file=0D09E17787BF2D57986E4271AA599A6D.jpg,url=https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=test]",
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

    const mockFetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );
    expect(fetchCalled).toBe(false);
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

  it("quotes with only image segment for single github.com link with image", async () => {
    let quotedMessage: unknown = null;
    const item: IncomingMessage = {
      event: {
        raw_message: "https://github.com/kidonng/sakurako",
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
    const mockFetch = async () => new Response(githubHtml, { status: 200 });

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );

    expect(quotedMessage).toEqual([
      {
        type: "image",
        data: {
          file: "https://opengraph.githubassets.com/repo/kidonng/sakurako",
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

    const item: IncomingMessage = {
      event: {
        raw_message: "https://news.ycombinator.com/item?id=50261319",
        message_type: "group",
        user_id: 10001,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async () => {
          throw new Error("OneBot API failed to send media");
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    const mockFetch = async () =>
      new Response(
        '<html><head><title>Preview Title</title><meta name="description" content="Preview Desc"></head></html>',
        { status: 200 },
      );

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch).pipe(
        Effect.provide(Logger.layer([testLogger])),
      ),
    );

    expect(loggedMessages.length).toBe(1);
    expect(loggedMessages[0]).toContain(
      "https://news.ycombinator.com/item?id=50261319",
    );
    expect(loggedMessages[0]).toContain("OneBot API failed to send media");
    expect(loggedMessages[0]).not.toContain("UnknownError");
  });

  it("quotes with text-only reply for Hacker News item containing y18.svg", async () => {
    let quotedMessage: unknown = null;
    const item: IncomingMessage = {
      event: {
        raw_message: "https://news.ycombinator.com/item?id=50261319",
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
    const mockFetch = async () => new Response(hnHtml, { status: 200 });

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );

    expect(quotedMessage).toEqual({
      type: "text",
      data: {
        text: "Genie 4 | Hacker News\nhttps://deepmind.google/blog/genie-4",
      },
    });
  });

  it("falls back to text-only quote when quote with image fails", async () => {
    const quotesAttempted: unknown[] = [];
    const item: IncomingMessage = {
      event: {
        raw_message: "https://example.com/with-image",
        message_type: "group",
        user_id: 10001,
        self_id: 99999,
        post_type: "message",
      } as unknown as OneBotMessageEvent,
      context: {
        quote: async (msg: unknown) => {
          quotesAttempted.push(msg);
          if (quotesAttempted.length === 1) {
            throw new Error("HTTP download failed: 403");
          }
          return { message_id: 12345 };
        },
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>,
    };

    const mockFetch = async () =>
      new Response(
        '<html><head><title>Title</title><meta property="og:image" content="https://example.com/cover.png"></head></html>',
        { status: 200 },
      );

    await Effect.runPromise(
      handleLinkPreviewMessage(item, mockFetch as unknown as typeof fetch),
    );

    expect(quotesAttempted.length).toBe(2);
    // First attempt included image segment
    expect(Array.isArray(quotesAttempted[0])).toBe(true);
    expect(
      (quotesAttempted[0] as Array<{ type: string }>).some(
        (s) => s.type === "image",
      ),
    ).toBe(true);
    // Second attempt was text-only
    expect(quotesAttempted[1]).toEqual({
      type: "text",
      data: {
        text: "Title",
      },
    });
  });
});
