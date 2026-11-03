/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { DanbooruClient } from "../../../src/features/danbooru/DanbooruClient.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

describe("DanbooruClient", () => {
  it("fetches random post successfully on HTTP 200", async () => {
    const mockPost = {
      id: 12345,
      large_file_url: "https://danbooru.donmai.us/data/large.jpg",
      tag_string_character: "reisen_udongein_inaba",
      tag_string_copyright: "touhou",
      tag_string_artist: "nacht_musik",
      tag_string_general: "1girl",
    };

    const clientLive = makeTestHttpClient((req) => {
      expect(req.url).toContain("https://danbooru.donmai.us/posts/random.json");
      expect(req.url).toContain("is%3Asfw");
      return new Response(JSON.stringify(mockPost), { status: 200 });
    });

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      const post = yield* client.getRandomPost(["touhou"]);
      expect(post.id).toBe(12345);
      expect(post.large_file_url).toBe(
        "https://danbooru.donmai.us/data/large.jpg",
      );
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(clientLive))),
      ),
    );
  });

  it("handles HTTP 204 or 404 as DanbooruNotFoundError", async () => {
    const client204 = makeTestHttpClient(
      () => new Response(null, { status: 204 }),
    );

    const program204 = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      return yield* client.getRandomPost(["non_existent_tag"]);
    });

    const result204 = await Effect.runPromise(
      program204.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(client204))),
        Effect.flip,
      ),
    );

    expect(result204._tag).toBe("DanbooruNotFoundError");

    const client404 = makeTestHttpClient(
      () => new Response("Not Found", { status: 404 }),
    );

    const result404 = await Effect.runPromise(
      program204.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(client404))),
        Effect.flip,
      ),
    );

    expect(result404._tag).toBe("DanbooruNotFoundError");
  });

  it("handles HTTP 429 as DanbooruRateLimitError", async () => {
    const client429 = makeTestHttpClient(
      () => new Response("Rate limited", { status: 429 }),
    );

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      return yield* client.getRandomPost([]);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(client429))),
        Effect.flip,
      ),
    );

    expect(result._tag).toBe("DanbooruRateLimitError");
  });

  it("handles HTTP 500 as DanbooruApiError", async () => {
    const client500 = makeTestHttpClient(
      () => new Response("Internal Server Error", { status: 500 }),
    );

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      return yield* client.getRandomPost([]);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(client500))),
        Effect.flip,
      ),
    );

    expect(result._tag).toBe("DanbooruApiError");
  });

  it("downloads image and encodes to base64 URI", async () => {
    const fakeImageBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const clientLive = makeTestHttpClient((req) => {
      expect(req.url).toBe("https://example.com/test.jpg");
      return new Response(fakeImageBuffer, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      const base64Uri = yield* client.downloadImage(
        "https://example.com/test.jpg",
      );
      expect(base64Uri.startsWith("base64://")).toBe(true);
      expect(base64Uri).toBe(
        `base64://${Buffer.from(fakeImageBuffer).toString("base64")}`,
      );
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(clientLive))),
      ),
    );
  });

  it("maps download failure to DanbooruApiError", async () => {
    const client403 = makeTestHttpClient(
      () => new Response("Forbidden", { status: 403 }),
    );

    const program = Effect.gen(function* () {
      const client = yield* DanbooruClient;
      return yield* client.downloadImage("https://example.com/forbidden.jpg");
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(DanbooruClient.layer.pipe(Layer.provide(client403))),
        Effect.flip,
      ),
    );

    expect(result._tag).toBe("DanbooruApiError");
  });
});
