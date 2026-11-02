import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { makeTestHttpClient } from "../TestHttpClient.ts";
import {
  cancelResponse,
  DEFAULT_USER_AGENT,
  executeWithResponse,
  fetchJson,
  fetchText,
  HttpFetchError,
} from "../../src/utils/HttpClient.ts";

describe("HttpClient utils", () => {
  describe("DEFAULT_USER_AGENT", () => {
    it("is Sakurako/1.0", () => {
      expect(DEFAULT_USER_AGENT).toBe("Sakurako/1.0");
    });
  });

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

    it("fails with HttpFetchError on non-2xx status and cancels response body", async () => {
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
      expect(error).toBeInstanceOf(HttpFetchError);
      expect(error.status).toBe(404);
      expect(error.statusText).toBe("Not Found");
      expect(error.message).toContain("HTTP 404 Not Found");
      expect(bodyCancelled).toBe(true);
    });

    it("fails with HttpFetchError when response reading times out", async () => {
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
      expect(error).toBeInstanceOf(HttpFetchError);
      expect(error.message).toContain("timed out");
    });
  });

  describe("fetchJson", () => {
    const TestSchema = Schema.Struct({
      id: Schema.Number,
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

    it("fails with HttpFetchError on schema validation failure", async () => {
      const layer = makeTestHttpClient(() => {
        return new Response(JSON.stringify({ id: "not-a-number", name: "Sakurako" }), {
          status: 200,
        });
      });

      const program = fetchJson(
        HttpClientRequest.get("https://example.com/invalid.json"),
        TestSchema,
      ).pipe(Effect.provide(layer), Effect.flip);

      const error = await Effect.runPromise(program);
      expect(error).toBeInstanceOf(HttpFetchError);
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
