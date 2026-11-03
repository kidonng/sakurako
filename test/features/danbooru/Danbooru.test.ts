/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { handleDanbooruMessage } from "../../../src/features/danbooru/Danbooru.ts";
import {
  DanbooruApiError,
  DanbooruClient,
  DanbooruNotFoundError,
} from "../../../src/features/danbooru/DanbooruClient.ts";
import { DanbooruTagMatcher } from "../../../src/features/danbooru/DanbooruTagMatcher.ts";
import type { IncomingMessage } from "../../../src/SnowLuma.ts";

describe("handleDanbooruMessage", () => {
  it("rejects queries with more than 2 tags", async () => {
    let replied = "";
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr tag1 tag2 tag3" } }],
      },
      context: {
        reply: (msg: string) => {
          replied = msg;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined as string | undefined),
      matchQuery: () =>
        Effect.succeed({ tags: ["t1", "t2", "t3"], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () => Effect.die("should not be called"),
      downloadImage: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(replied).toBe("[标签数量超出限制，最多支持 2 个]");
  });

  it("replies with formatted title and image when search succeeds", async () => {
    let replyPayload: unknown = null;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr 白发" } }],
      },
      context: {
        reply: (payload: unknown) => {
          replyPayload = payload;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined as string | undefined),
      matchQuery: () =>
        Effect.succeed({ tags: ["white_hair"], isModified: true }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 100,
          large_file_url: "https://example.com/100.jpg",
          tag_string_character: "",
          tag_string_copyright: "",
          tag_string_artist: "artist",
          tag_string_general: "white_hair",
        }),
      downloadImage: () => Effect.succeed("base64://fakeimagedata"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(replyPayload).toBeDefined();
    // Payload should be an array of message segments with text including 🔍 white_hair and image
    expect(Array.isArray(replyPayload)).toBe(true);
    const arr = replyPayload as {
      type: string;
      data: Record<string, unknown>;
    }[];
    expect(arr.some((s) => s.type === "text" && s.data.text?.toString().includes("🔍 white_hair"))).toBe(true);
    expect(
      arr.some(
        (s) => s.type === "image" && s.data.file === "base64://fakeimagedata",
      ),
    ).toBe(true);
  });

  it("replies with not found message when Danbooru returns DanbooruNotFoundError", async () => {
    let replied = "";
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr test" } }],
      },
      context: {
        reply: (msg: string) => {
          replied = msg;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined as string | undefined),
      matchQuery: () => Effect.succeed({ tags: ["test"], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.fail(new DanbooruNotFoundError({ queryTags: "test" })),
      downloadImage: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(replied).toBe("[未找到符合条件的图片]");
  });

  it("replies when input terms yield no valid tags", async () => {
    let replied = "";
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr ????" } }],
      },
      context: {
        reply: (msg: string) => {
          replied = msg;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined as string | undefined),
      matchQuery: () => Effect.succeed({ tags: [], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () => Effect.die("should not be called"),
      downloadImage: () => Effect.die("should not be called"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(replied).toBe("[未找到匹配的标签]");
  });

  it("replies with download failure message when image download fails", async () => {
    let replied = "";
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr" } }],
      },
      context: {
        reply: (msg: string) => {
          replied = msg;
          return Promise.resolve();
        },
      },
    } as unknown as IncomingMessage;

    const MatcherMock = Layer.succeed(DanbooruTagMatcher, {
      matchTag: () => Effect.succeed(undefined as string | undefined),
      matchQuery: () => Effect.succeed({ tags: [], isModified: false }),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 100,
          large_file_url: "https://example.com/100.jpg",
          tag_string_character: "",
          tag_string_copyright: "",
          tag_string_artist: "artist",
          tag_string_general: "white_hair",
        }),
      downloadImage: () =>
        Effect.fail(
          new DanbooruApiError({
            status: 403,
            message: "HTTP 403",
          }),
        ),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(replied).toBe("[下载图片失败]");
  });
});
