/* oxlint-disable effecttsgo/unstable-api-usage */
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { BotConfig } from "../../Config.ts";
import { fetchJson, type HttpFetchError } from "../../utils/HttpClient.ts";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_BODY_TIMEOUT_MS = 25_000;
const FIRECRAWL_HTTP_TIMEOUT = "30 seconds";

interface FallbackMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
}

export interface FallbackScrapeResult {
  readonly engineId: string;
  readonly url: string;
  readonly html?: string;
  readonly metadata?: FallbackMetadata;
}

export class FallbackScrapeError extends Schema.TaggedError<
  FallbackScrapeError,
  {
    readonly brand: unique symbol;
  }
>()("FallbackScrapeError", {
  engineId: Schema.String,
  url: Schema.String,
  reason: Schema.String,
  status: Schema.optional(Schema.Finite),
}) {
  override get message(): string {
    return `${this.engineId}: ${this.reason}`;
  }
}

export interface ScraperEngine {
  readonly id: string;
  readonly scrape: (
    url: string,
  ) => Effect.Effect<FallbackScrapeResult, FallbackScrapeError>;
}

const StringOrStringArray = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]);

const FirecrawlMetadataSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(StringOrStringArray)),
  description: Schema.optional(Schema.NullOr(StringOrStringArray)),
  ogTitle: Schema.optional(Schema.NullOr(StringOrStringArray)),
  ogDescription: Schema.optional(Schema.NullOr(StringOrStringArray)),
  ogImage: Schema.optional(Schema.NullOr(StringOrStringArray)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  sourceURL: Schema.optional(Schema.NullOr(Schema.String)),
  statusCode: Schema.optional(Schema.NullOr(Schema.Finite)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

const FirecrawlScrapeResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        rawHtml: Schema.optional(Schema.NullOr(Schema.String)),
        metadata: Schema.optional(Schema.NullOr(FirecrawlMetadataSchema)),
      }),
    ),
  ),
});

function pickFirstString(
  value: string | ReadonlyArray<string> | null | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Predicate.isString(value)) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  for (const item of value) {
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function getHttpErrorStatus(error: HttpFetchError): number | undefined {
  switch (error._tag) {
    case "HttpNotFoundError":
    case "HttpNoContentError":
    case "HttpRateLimitError":
    case "HttpNetworkError":
      return error.status;
    case "HttpTimeoutError":
      return undefined;
  }
}

export function createFirecrawlEngine(
  httpClient: HttpClient.HttpClient,
  apiKey?: Redacted.Redacted<string>,
): ScraperEngine {
  return {
    id: "firecrawl",
    scrape: Effect.fn("FallbackScraper.firecrawl")(function* (url: string) {
      const baseRequest = HttpClientRequest.post(FIRECRAWL_SCRAPE_URL).pipe(
        HttpClientRequest.acceptJson,
      );
      const authedRequest = apiKey
        ? HttpClientRequest.bearerToken(baseRequest, Redacted.value(apiKey))
        : baseRequest;

      const request = yield* HttpClientRequest.bodyJson(authedRequest, {
        url,
        formats: ["rawHtml"],
        timeout: FIRECRAWL_BODY_TIMEOUT_MS,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new FallbackScrapeError({
              engineId: "firecrawl",
              url,
              reason: `Failed to serialize request body: ${String(cause)}`,
            }),
        ),
      );

      const response = yield* fetchJson(
        request,
        FirecrawlScrapeResponseSchema,
        {
          timeoutDuration: FIRECRAWL_HTTP_TIMEOUT,
        },
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(
          (error) =>
            new FallbackScrapeError({
              engineId: "firecrawl",
              url,
              reason: error.message,
              status: getHttpErrorStatus(error),
            }),
        ),
      );

      if (!response.success || !response.data) {
        return yield* new FallbackScrapeError({
          engineId: "firecrawl",
          url,
          reason:
            response.error ??
            response.code ??
            "Firecrawl returned unsuccessful scrape response",
        });
      }

      const meta = response.data.metadata ?? undefined;
      const statusCode = meta?.statusCode ?? undefined;
      if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
        return yield* new FallbackScrapeError({
          engineId: "firecrawl",
          url,
          reason:
            pickFirstString(meta?.error) ??
            `Target site returned HTTP ${statusCode}`,
          status: statusCode,
        });
      }

      const rawHtml = response.data.rawHtml;
      const html =
        Predicate.isString(rawHtml) && rawHtml.trim().length > 0
          ? rawHtml
          : undefined;

      const title =
        pickFirstString(meta?.ogTitle) ?? pickFirstString(meta?.title);
      const description =
        pickFirstString(meta?.ogDescription) ??
        pickFirstString(meta?.description);
      const image = pickFirstString(meta?.ogImage);
      const metadata: FallbackMetadata | undefined =
        title || description || image
          ? {
              ...(title ? { title } : {}),
              ...(description ? { description } : {}),
              ...(image ? { image } : {}),
            }
          : undefined;

      if (!html && !metadata) {
        return yield* new FallbackScrapeError({
          engineId: "firecrawl",
          url,
          reason: "Firecrawl returned empty content and metadata",
        });
      }

      const resolvedUrl =
        pickFirstString(meta?.url) ?? pickFirstString(meta?.sourceURL) ?? url;

      return {
        engineId: "firecrawl",
        url: resolvedUrl,
        ...(html ? { html } : {}),
        ...(metadata ? { metadata } : {}),
      };
    }),
  };
}

export class FallbackScraper extends Context.Service<
  FallbackScraper,
  {
    readonly scrape: (
      url: string,
    ) => Effect.Effect<FallbackScrapeResult, FallbackScrapeError>;
  }
>()("sakurako/link-preview/FallbackScraper") {
  static readonly DEFAULT_CONCURRENCY = 2;

  static fromEngines(
    engines: ReadonlyArray<ScraperEngine>,
    concurrency: number = FallbackScraper.DEFAULT_CONCURRENCY,
  ): FallbackScraper["Service"] {
    const semaphore = Semaphore.makeUnsafe(concurrency);

    return FallbackScraper.of({
      scrape: (url: string) =>
        semaphore.withPermit(
          Effect.gen(function* () {
            if (engines.length === 0) {
              return yield* new FallbackScrapeError({
                engineId: "none",
                url,
                reason: "No fallback scraper engines configured",
              });
            }

            let lastError: FallbackScrapeError | undefined;
            for (const engine of engines) {
              const attempt = yield* engine.scrape(url).pipe(Effect.result);
              if (attempt._tag === "Success") {
                return attempt.success;
              }
              lastError = attempt.failure;
              yield* Effect.logWarning(
                `Fallback engine "${engine.id}" failed for ${url}: ${attempt.failure.reason}`,
              );
            }

            return yield* lastError!;
          }),
        ),
    });
  }

  static layerFromEngines(
    engines: ReadonlyArray<ScraperEngine>,
    concurrency: number = FallbackScraper.DEFAULT_CONCURRENCY,
  ): Layer.Layer<FallbackScraper> {
    return Layer.succeed(
      FallbackScraper,
      FallbackScraper.fromEngines(engines, concurrency),
    );
  }

  static readonly layer: Layer.Layer<
    FallbackScraper,
    never,
    HttpClient.HttpClient
  > = Layer.effect(
    FallbackScraper,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const config = yield* Effect.option(BotConfig);
      const firecrawlApiKey = Option.getOrUndefined(config)?.firecrawlApiKey;
      return FallbackScraper.fromEngines([
        createFirecrawlEngine(httpClient, firecrawlApiKey),
      ]);
    }),
  );
}
