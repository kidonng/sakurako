/* oxlint-disable effecttsgo/unstable-api-usage */
import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { makeTestHttpClient } from "../TestHttpClient.ts";
import {
  cancelResponse,
  executeWithResponse,
  fetchJson,
  fetchText,
  fetchImage,
  HttpNetworkError,
  HttpNoContentError,
  HttpNotFoundError,
  HttpRateLimitError,
  HttpTimeoutError,
} from "../../src/utils/HttpClient.ts";

describe("HttpClient utils", () => {
  describe("executeWithResponse / fetchText", () => {
    it("returns text and target url on 200 OK", async () => {
      const layer = makeTestHttpClient((req) => {
        expect(req.url).toBe("https://example.com/page");
        return new Response("<html>hello</html>", { status: 200 });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/page"),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result.text).toBe("<html>hello</html>");
      expect(result.url).toBe("https://example.com/page");
    });

    it('decodes GB2312 HTML response when specified in <meta charset="gb2312">', async () => {
      const prefix = new TextEncoder().encode(
        '<!DOCTYPE html><html><head><meta charset="gb2312"><title>',
      );
      // "杭州临平" in GBK/GB2312 bytes
      const gbkTitle = [0xba, 0xbc, 0xd6, 0xdd, 0xc1, 0xd9, 0xc6, 0xbd];
      const suffix = new TextEncoder().encode(
        "</title></head><body></body></html>",
      );
      const body = new Uint8Array(
        prefix.length + gbkTitle.length + suffix.length,
      );
      body.set(prefix, 0);
      body.set(gbkTitle, prefix.length);
      body.set(suffix, prefix.length + gbkTitle.length);

      const layer = makeTestHttpClient(() => {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      });

      const program = fetchText(
        HttpClientRequest.get("https://news.cnr.cn/native/gd/test.shtml"),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result.text).toContain("杭州临平");
    });

    it("decodes response when charset is specified in Content-Type header", async () => {
      const gbkBytes = new Uint8Array([
        0xba, 0xbc, 0xd6, 0xdd, 0xc1, 0xd9, 0xc6, 0xbd,
      ]);
      const layer = makeTestHttpClient(() => {
        return new Response(gbkBytes, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=gbk" },
        });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/test.txt"),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result.text).toBe("杭州临平");
    });

    it('overrides generic ISO-8859-1 Content-Type with HTML <meta charset="gb2312">', async () => {
      const prefix = new TextEncoder().encode(
        '<!DOCTYPE html><html><head><meta charset="gb2312"><title>',
      );
      const gbkTitle = [0xba, 0xbc, 0xd6, 0xdd, 0xc1, 0xd9, 0xc6, 0xbd];
      const suffix = new TextEncoder().encode(
        "</title></head><body></body></html>",
      );
      const body = new Uint8Array(
        prefix.length + gbkTitle.length + suffix.length,
      );
      body.set(prefix, 0);
      body.set(gbkTitle, prefix.length);
      body.set(suffix, prefix.length + gbkTitle.length);

      const layer = makeTestHttpClient(() => {
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=iso-8859-1" },
        });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/legacy.html"),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result.text).toContain("杭州临平");
    });

    it("automatically attaches DEFAULT_USER_AGENT when User-Agent is unset", async () => {
      let capturedUa: string | undefined;
      const layer = makeTestHttpClient((req) => {
        capturedUa = req.headers["user-agent"];
        return new Response("ok", { status: 200 });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/check-ua"),
      ).pipe(Effect.provide(layer));

      await Effect.runPromise(program);
      expect(capturedUa).toBe("Sakurako/1.0");
    });

    it("preserves explicit User-Agent if already set on request", async () => {
      let capturedUa: string | undefined;
      const layer = makeTestHttpClient((req) => {
        capturedUa = req.headers["user-agent"];
        return new Response("ok", { status: 200 });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/check-ua").pipe(
          HttpClientRequest.setHeader("User-Agent", "CustomBot/2.0"),
        ),
      ).pipe(Effect.provide(layer));

      await Effect.runPromise(program);
      expect(capturedUa).toBe("CustomBot/2.0");
    });

    it("fails with HttpNotFoundError on 404 status and cancels response body", async () => {
      let bodyCancelled = false;
      const layer = makeTestHttpClient(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("error"));
          },
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(stream, {
          status: 404,
          statusText: "Not Found",
        });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/missing"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpNotFoundError);
      expect(error._tag).toBe("HttpNotFoundError");
      if (error instanceof HttpNotFoundError) {
        expect(error.status).toBe(404);
        expect(error.statusText).toBe("Not Found");
      }
      expect(error.message).toContain("HTTP 404 Not Found");
      expect(bodyCancelled).toBe(true);
    });

    it("fails with HttpRateLimitError on 429 status and cancels response body", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("Rate Limited", {
            status: 429,
            statusText: "Too Many Requests",
          }),
      );
      const program = fetchText(
        HttpClientRequest.get("https://example.com/api"),
      ).pipe(Effect.provide(layer), Effect.flip);
      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpRateLimitError);
      expect(error._tag).toBe("HttpRateLimitError");
      if (error instanceof HttpRateLimitError) {
        expect(error.status).toBe(429);
      }
      expect(error.message).toContain("HTTP 429 Too Many Requests");
    });

    it("populates retryAfterMs from Retry-After seconds header on 429", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("Too many requests", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "2" },
          }),
      );
      const error = await Effect.runPromise(
        fetchText(HttpClientRequest.get("https://example.com/api")).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );
      expect(error).toBeInstanceOf(HttpRateLimitError);
      if (error instanceof HttpRateLimitError) {
        expect(error.retryAfterMs).toBe(2000);
      }
    });

    it("populates retryAfterMs from Retry-After HTTP-date header on 429", async () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const layer = makeTestHttpClient(
        () =>
          new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": futureDate },
          }),
      );
      const error = await Effect.runPromise(
        fetchText(HttpClientRequest.get("https://example.com/api")).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );
      expect(error).toBeInstanceOf(HttpRateLimitError);
      if (error instanceof HttpRateLimitError) {
        expect(error.retryAfterMs).toBeGreaterThan(2000);
        expect(error.retryAfterMs).toBeLessThanOrEqual(6000);
      }
    });

    it("treats Retry-After: 0 as 0ms instead of missing", async () => {
      const layer = makeTestHttpClient(
        () =>
          new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": "0" },
          }),
      );
      const error = await Effect.runPromise(
        fetchText(HttpClientRequest.get("https://example.com/api")).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      );
      expect(error).toBeInstanceOf(HttpRateLimitError);
      if (error instanceof HttpRateLimitError) {
        expect(error.retryAfterMs).toBe(0);
      }
    });

    it("fails with HttpNetworkError on other non-2xx status", async () => {
      const layer403 = makeTestHttpClient(
        () =>
          new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      );
      const program403 = fetchText(
        HttpClientRequest.get("https://example.com/api"),
      ).pipe(Effect.provide(layer403), Effect.flip);
      const error403 = await Effect.runPromise(program403);
      expect(error403).toBeInstanceOf(HttpNetworkError);
      expect(error403._tag).toBe("HttpNetworkError");
      if (error403 instanceof HttpNetworkError) {
        expect(error403.status).toBe(403);
        expect(error403.statusText).toBe("Forbidden");
      }
      expect(error403.message).toContain("HTTP 403 Forbidden");

      const layer500 = makeTestHttpClient(
        () =>
          new Response("Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
      );
      const program500 = fetchText(
        HttpClientRequest.get("https://example.com/api"),
      ).pipe(Effect.provide(layer500), Effect.flip);
      const error500 = await Effect.runPromise(program500);
      expect(error500).toBeInstanceOf(HttpNetworkError);
      expect(error500._tag).toBe("HttpNetworkError");
      if (error500 instanceof HttpNetworkError) {
        expect(error500.status).toBe(500);
        expect(error500.statusText).toBe("Internal Server Error");
      }
      expect(error500.message).toContain("HTTP 500 Internal Server Error");
    });

    it("fails with HttpTimeoutError when response reading times out", async () => {
      const layer = makeTestHttpClient(() => {
        const stream = new ReadableStream({
          start() {
            // Never emits or finishes
          },
        });
        return new Response(stream, { status: 200 });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/stalled"),
        { timeoutDuration: "50 millis" },
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpTimeoutError);
      expect(error._tag).toBe("HttpTimeoutError");
      expect(error.message).toContain("timed out");
    });

    it("fails with HttpNetworkError containing read detail when response body read fails", async () => {
      const layer = makeTestHttpClient(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.error(new Error("Network connection reset"));
          },
        });
        return new Response(stream, { status: 200 });
      });

      const program = fetchText(
        HttpClientRequest.get("https://example.com/broken-stream"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error._tag).toBe("HttpNetworkError");
      if (error instanceof HttpNetworkError) {
        expect(error.status).toBeUndefined();
      }
      expect(error.message).toContain("Failed to read response text");
    });
  });

  describe("fetchJson", () => {
    const TestSchema = Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
    });

    it("decodes valid json according to schema", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response(JSON.stringify({ id: 42, name: "Sakurako" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const program = fetchJson(
        HttpClientRequest.get("https://example.com/data.json"),
        TestSchema,
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result).toEqual({ id: 42, name: "Sakurako" });
    });

    it("fails with HttpNoContentError when fetchJson receives 204", async () => {
      const layer = makeTestHttpClient(
        () => new Response(null, { status: 204 }),
      );
      const program = fetchJson(
        HttpClientRequest.get("https://example.com/empty"),
        TestSchema,
      ).pipe(Effect.provide(layer), Effect.flip);
      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpNoContentError);
      expect(error._tag).toBe("HttpNoContentError");
      if (error instanceof HttpNoContentError) {
        expect(error.status).toBe(204);
      }
    });

    it("fails with HttpNetworkError on schema validation failure", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response(
          JSON.stringify({ id: "not-a-number", name: "Sakurako" }),
          {
            status: 200,
          },
        );
      });

      const program = fetchJson(
        HttpClientRequest.get("https://example.com/invalid.json"),
        TestSchema,
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error._tag).toBe("HttpNetworkError");
      if (error instanceof HttpNetworkError) {
        expect(error.status).toBeUndefined();
      }
      expect(error.message).toContain("Failed to parse response JSON");
    });
  });

  describe("cancelResponse", () => {
    it("safely handles response whose body has already been consumed", async () => {
      let bodyCancelled = false;
      const layer = makeTestHttpClient(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("read-me"));
            controller.close();
          },
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(stream, { status: 200 });
      });

      const program = executeWithResponse(
        HttpClientRequest.get("https://example.com/consumed"),
        (response) =>
          Effect.gen(function* () {
            const text = yield* response.text;
            // cancelResponse on already consumed response must not throw
            cancelResponse(response);
            return text;
          }),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result).toBe("read-me");
      expect(bodyCancelled).toBe(false);
    });
  });

  describe("fetchImage", () => {
    it("downloads image and encodes to base64 URI", async () => {
      const mockBytes = new Uint8Array([1, 2, 3, 4]);
      const layer = makeTestHttpClient(() => {
        return new Response(mockBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/pic.png"),
      ).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result).toBe(
        `base64://${Buffer.from(mockBytes).toString("base64")}`,
      );
    });

    it("fails with HttpNetworkError when Content-Type is missing or not image", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response("<html>not image</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/page"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error._tag).toBe("HttpNetworkError");
      expect(error.message).toContain("Unsupported or non-image Content-Type");
    });

    it("fails with HttpNetworkError when Content-Type is image/svg+xml", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response("<svg></svg>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/vector.svg"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error._tag).toBe("HttpNetworkError");
      expect(error.message).toContain("Unsupported or non-image Content-Type");
    });

    it("fails with HttpNetworkError when declared Content-Length exceeds maxBytes", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "20000000",
          },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/huge.jpg"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error._tag).toBe("HttpNetworkError");
      expect(error.message).toContain("Image size exceeds limit");
    });

    it("fails with HttpNetworkError when body size exceeds maxBytes", async () => {
      const oversizedBytes = new Uint8Array(11 * 1024 * 1024);
      const layer = makeTestHttpClient(() => {
        return new Response(oversizedBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/oversized.jpg"),
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error._tag).toBe("HttpNetworkError");
      expect(error.message).toContain("Image size exceeds limit");
    });

    it("respects custom maxBytes option", async () => {
      const mockBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const layer = makeTestHttpClient(() => {
        return new Response(mockBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      });

      const program = fetchImage(
        HttpClientRequest.get("https://example.com/small.jpg"),
        { maxBytes: 4 },
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error._tag).toBe("HttpNetworkError");
      expect(error.message).toContain("Image size exceeds limit");
    });
  });
});
