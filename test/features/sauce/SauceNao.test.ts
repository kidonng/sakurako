/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Redacted } from "effect";
import {
  SauceNaoError,
  searchSauce,
  TARGET_SAUCENAO_DBS,
} from "../../../src/features/sauce/SauceNao.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

describe("searchSauce", () => {
  it("formats Pixiv result with title, author, and external URL", async () => {
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "85.34",
            index_id: 5,
          },
          data: {
            title: "Sakura Blossom",
            member_name: "ArtistA",
            ext_urls: ["https://www.pixiv.net/artworks/12345678"],
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/image.jpg").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Sakura Blossom");
    expect(result?.author).toBe("ArtistA");
    expect(result?.url).toBe("https://www.pixiv.net/artworks/12345678");
    expect(result?.similarity).toBe(85.34);
    expect(result?.formattedText).toBe(
      "Sakura Blossom by ArtistA\nhttps://www.pixiv.net/artworks/12345678",
    );
  });

  it("formats anime screenshot with source and part without author", async () => {
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "92.10",
            index_id: 21,
          },
          data: {
            source: "Fate/Zero",
            part: "EP.01",
            ext_urls: ["https://anidb.net/anime/8160"],
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/anime.jpg").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Fate/Zero EP.01");
    expect(result?.author).toBeUndefined();
    expect(result?.url).toBe("https://anidb.net/anime/8160");
    expect(result?.similarity).toBe(92.1);
    expect(result?.formattedText).toBe(
      "Fate/Zero EP.01\nhttps://anidb.net/anime/8160",
    );
  });

  it("omits URL line when result has no external URL", async () => {
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "75.00",
            index_id: 2,
          },
          data: {
            title: "Offline Art",
            creator: "LocalArtist",
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/local.jpg").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Offline Art");
    expect(result?.author).toBe("LocalArtist");
    expect(result?.url).toBeUndefined();
    expect(result?.formattedText).toBe("Offline Art by LocalArtist");
  });

  it("returns null when similarity is below minimum_similarity", async () => {
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 70.0,
      },
      results: [
        {
          header: {
            similarity: "55.20",
          },
          data: {
            title: "Low Match",
            ext_urls: ["https://example.com/match"],
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/low.jpg").pipe(Effect.provide(layer)),
    );

    expect(result).toBeNull();
  });

  it("returns null when results array is empty", async () => {
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/empty.jpg").pipe(Effect.provide(layer)),
    );

    expect(result).toBeNull();
  });

  it("fails with SauceNaoError on non-zero status in header", async () => {
    const mockResponse = {
      header: {
        status: -1,
        message: "Problem with image",
      },
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const error = await Effect.runPromise(
      searchSauce("https://example.com/error.jpg").pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(SauceNaoError);
    expect(error.cause).toBe("Problem with image");
  });

  it("fails with SauceNaoError on HTTP 500 error", async () => {
    const layer = makeTestHttpClient(
      () => new Response("Server error", { status: 500 }),
    );
    const error = await Effect.runPromise(
      searchSauce("https://example.com/error.jpg").pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(SauceNaoError);
  });

  it("appends api_key query parameter when apiKey is provided", async () => {
    let requestedUrl = "";
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "80.00",
          },
          data: {
            title: "Test",
          },
        },
      ],
    };

    const layer = makeTestHttpClient((req) => {
      requestedUrl = req.url;
      return Response.json(mockResponse);
    });

    await Effect.runPromise(
      searchSauce(
        "https://example.com/pic.png",
        Redacted.make("secret_sauce_key"),
      ).pipe(Effect.provide(layer)),
    );

    const searchParams = new URL(requestedUrl).searchParams;
    expect(searchParams.get("api_key")).toBe("secret_sauce_key");
    expect(searchParams.get("output_type")).toBe("2");
    expect(searchParams.get("numres")).toBe("5");
    expect(searchParams.get("db")).toBeNull();
    expect(searchParams.get("url")).toBe("https://example.com/pic.png");
    expect(searchParams.getAll("dbs[]")).toEqual(
      TARGET_SAUCENAO_DBS.map(String),
    );
  });

  it("queries SauceNao with numres=5, no db=999, and dbs[] for all target databases", async () => {
    let requestedUrl = "";
    const mockResponse = {
      header: {
        status: 0,
        minimum_similarity: 60.0,
      },
      results: [
        {
          header: {
            similarity: "80.00",
            index_id: 5,
          },
          data: {
            title: "Test Image",
          },
        },
      ],
    };

    const layer = makeTestHttpClient((req) => {
      requestedUrl = req.url;
      return Response.json(mockResponse);
    });

    await Effect.runPromise(
      searchSauce("https://example.com/pic.png").pipe(Effect.provide(layer)),
    );

    const searchParams = new URL(requestedUrl).searchParams;
    expect(searchParams.get("output_type")).toBe("2");
    expect(searchParams.get("numres")).toBe("5");
    expect(searchParams.get("db")).toBeNull();
    expect(searchParams.get("url")).toBe("https://example.com/pic.png");
    expect(searchParams.getAll("dbs[]")).toEqual(
      TARGET_SAUCENAO_DBS.map(String),
    );
  });

  it("prefers primary origin platform (Pixiv) over booru when within 2.0% similarity tolerance", async () => {
    const mockResponse = {
      header: { status: 0, minimum_similarity: 60.0 },
      results: [
        {
          header: { similarity: "91.50", index_id: 9 }, // Danbooru
          data: {
            title: "Booru Reupload",
            ext_urls: ["https://danbooru.donmai.us/posts/1"],
          },
        },
        {
          header: { similarity: "90.20", index_id: 5 }, // Pixiv
          data: {
            title: "Original Art",
            member_name: "OriginalArtist",
            ext_urls: ["https://www.pixiv.net/artworks/1"],
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Original Art");
    expect(result?.author).toBe("OriginalArtist");
    expect(result?.url).toBe("https://www.pixiv.net/artworks/1");
    expect(result?.similarity).toBe(90.2);
  });

  it("prefers higher similarity match when difference exceeds 2.0% tolerance even if lower match is an origin platform", async () => {
    const mockResponse = {
      header: { status: 0, minimum_similarity: 60.0 },
      results: [
        {
          header: { similarity: "95.00", index_id: 9 }, // Danbooru
          data: {
            title: "Clear Match",
            ext_urls: ["https://danbooru.donmai.us/posts/2"],
          },
        },
        {
          header: { similarity: "75.00", index_id: 5 }, // Pixiv
          data: {
            title: "Low Confidence Pixiv",
            member_name: "SomeArtist",
            ext_urls: ["https://www.pixiv.net/artworks/2"],
          },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Clear Match");
    expect(result?.similarity).toBe(95.0);
  });

  it("returns highest similarity candidate among non-origin platforms", async () => {
    const mockResponse = {
      header: { status: 0, minimum_similarity: 60.0 },
      results: [
        {
          header: { similarity: "82.00", index_id: 25 }, // Gelbooru
          data: { title: "Lower Non-Origin" },
        },
        {
          header: { similarity: "89.00", index_id: 9 }, // Danbooru
          data: { title: "Higher Non-Origin" },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Higher Non-Origin");
    expect(result?.similarity).toBe(89.0);
  });

  it("returns null when all candidates have similarity below minimum_similarity", async () => {
    const mockResponse = {
      header: { status: 0, minimum_similarity: 60.0 },
      results: [
        {
          header: { similarity: "58.00", index_id: 5 },
          data: { title: "Low similarity" },
        },
        {
          header: { similarity: "40.00", index_id: 9 },
          data: { title: "Even lower" },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
    );

    expect(result).toBeNull();
  });

  it("safely handles candidates with missing index_id or missing similarity", async () => {
    const mockResponse = {
      header: { status: 0, minimum_similarity: 60.0 },
      results: [
        {
          header: {},
          data: { title: "Missing Similarity" },
        },
        {
          header: { similarity: "78.00" }, // missing index_id
          data: { title: "Valid Non-Origin" },
        },
      ],
    };

    const layer = makeTestHttpClient(() => Response.json(mockResponse));
    const result = await Effect.runPromise(
      searchSauce("https://example.com/test.png").pipe(Effect.provide(layer)),
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Valid Non-Origin");
    expect(result?.similarity).toBe(78.0);
  });
});
