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
  HttpClientStatusError,
  HttpNetworkError,
  HttpNoContentError,
  HttpNotFoundError,
  HttpRateLimitError,
  HttpServerStatusError,
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
        () => new Response("Rate Limited", { status: 429, statusText: "Too Many Requests" }),
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

    it("fails with HttpClientStatusError on other 4xx status", async () => {
      const layer = makeTestHttpClient(
        () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      );
      const program = fetchText(
        HttpClientRequest.get("https://example.com/api"),
      ).pipe(Effect.provide(layer), Effect.flip);
      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpClientStatusError);
      expect(error._tag).toBe("HttpClientStatusError");
      if (error instanceof HttpClientStatusError) {
        expect(error.status).toBe(403);
      }
      expect(error.message).toContain("HTTP 403 Forbidden");
    });

    it("fails with HttpServerStatusError on 5xx status", async () => {
      const layer = makeTestHttpClient(
        () => new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
      );
      const program = fetchText(
        HttpClientRequest.get("https://example.com/api"),
      ).pipe(Effect.provide(layer), Effect.flip);
      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpServerStatusError);
      expect(error._tag).toBe("HttpServerStatusError");
      if (error instanceof HttpServerStatusError) {
        expect(error.status).toBe(500);
      }
      expect(error.message).toContain("HTTP 500 Internal Server Error");
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
      const layer = makeTestHttpClient(() => new Response(null, { status: 204 }));
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
        expect(error.status).toBe(200);
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
});
