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
      getTagTranslations: () => Effect.succeed(new Map()),
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

  it("replies with formatted title, link, and image when search succeeds, prompting Chinese tag when user input differs", async () => {
    let replyPayload: unknown = null;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr white_hair" } }],
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
        Effect.succeed({ tags: ["white_hair"], isModified: false }),
      getTagTranslations: () =>
        Effect.succeed(new Map([["white_hair", "白发"]])),
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
    expect(Array.isArray(replyPayload)).toBe(true);
    const arr = replyPayload as {
      type: string;
      data: Record<string, unknown>;
    }[];
    const textSegment = arr.find((s) => s.type === "text");
    expect(textSegment).toBeDefined();
    const text = textSegment?.data.text?.toString() ?? "";

    // Should prompt Chinese tag because user input "white_hair" != Chinese translation "白发"
    expect(text).toContain("🔍 白发\n");
    // Should contain post URL right after title
    expect(text).toContain("https://danbooru.donmai.us/posts/100");
    expect(text).toContain("画师 artist");
    expect(
      arr.some(
        (s) => s.type === "image" && s.data.file === "base64://fakeimagedata",
      ),
    ).toBe(true);
  });

  it("omits search hint when user input matches Chinese translation", async () => {
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
      getTagTranslations: () =>
        Effect.succeed(new Map([["white_hair", "白发"]])),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 101,
          large_file_url: "https://example.com/101.jpg",
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

    const arr = replyPayload as {
      type: string;
      data: Record<string, unknown>;
    }[];
    const textSegment = arr.find((s) => s.type === "text");
    const text = textSegment?.data.text?.toString() ?? "";

    // No search hint because user input "白发" == Chinese translation "白发"
    expect(text).not.toContain("🔍");
    expect(text).toContain("https://danbooru.donmai.us/posts/101");
  });

  it("hints corrected Chinese tag for partial or typo input", async () => {
    let replyPayload: unknown = null;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr 初音" } }],
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
        Effect.succeed({ tags: ["hatsune_miku"], isModified: true }),
      getTagTranslations: () =>
        Effect.succeed(new Map([["hatsune_miku", "初音未来（VOCALOID）"]])),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 102,
          large_file_url: "https://example.com/102.jpg",
          tag_string_character: "hatsune_miku",
          tag_string_copyright: "vocaloid",
          tag_string_artist: "artist",
          tag_string_general: "",
        }),
      downloadImage: () => Effect.succeed("base64://fakeimagedata"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    const arr = replyPayload as {
      type: string;
      data: Record<string, unknown>;
    }[];
    const textSegment = arr.find((s) => s.type === "text");
    const text = textSegment?.data.text?.toString() ?? "";

    expect(text).toContain("🔍 初音未来\n");
    expect(text).not.toContain("VOCALOID");
  });

  it("omits search hint when user input matches character base name without series suffix", async () => {
    let replyPayload: unknown = null;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "/dbr 御坂美琴" } }],
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
        Effect.succeed({ tags: ["misaka_mikoto"], isModified: false }),
      getTagTranslations: () =>
        Effect.succeed(
          new Map([["misaka_mikoto", "御坂美琴（魔法禁书目录）"]]),
        ),
    });
    const ClientMock = Layer.succeed(DanbooruClient, {
      getRandomPost: () =>
        Effect.succeed({
          id: 560660,
          large_file_url: "https://example.com/560660.jpg",
          tag_string_character: "misaka_mikoto",
          tag_string_copyright: "toaru_majutsu_no_index",
          tag_string_artist: "artist",
          tag_string_general: "",
        }),
      downloadImage: () => Effect.succeed("base64://fakeimagedata"),
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    const arr = replyPayload as {
      type: string;
      data: Record<string, unknown>;
    }[];
    const textSegment = arr.find((s) => s.type === "text");
    const text = textSegment?.data.text?.toString() ?? "";

    expect(text).not.toContain("🔍");
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
      getTagTranslations: () => Effect.succeed(new Map()),
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
      getTagTranslations: () => Effect.succeed(new Map()),
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
      getTagTranslations: () => Effect.succeed(new Map()),
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
