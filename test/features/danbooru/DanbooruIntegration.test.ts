/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { handleDanbooruMessage } from "../../../src/features/danbooru/Danbooru.ts";
import { DanbooruClient } from "../../../src/features/danbooru/DanbooruClient.ts";
import { DanbooruTagMatcher } from "../../../src/features/danbooru/DanbooruTagMatcher.ts";
import type { IncomingMessage } from "../../../src/SnowLuma.ts";

describe("Danbooru integration message flow", () => {
  it("ignores non-dbr commands silently", async () => {
    let called = false;
    const fakeItem = {
      event: {
        post_type: "message",
        message_type: "group",
        user_id: 10001,
        message: [{ type: "text", data: { text: "hello world" } }],
      },
      context: {
        reply: () => {
          called = true;
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
    });

    await Effect.runPromise(
      handleDanbooruMessage(fakeItem).pipe(
        Effect.provide(Layer.merge(MatcherMock, ClientMock)),
      ),
    );

    expect(called).toBe(false);
  });
});
