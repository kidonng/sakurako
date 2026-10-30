/* oxlint-disable effecttsgo/unstable-api-usage */
import { type Duration, Effect, Redacted, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  Url,
} from "effect/http";

export interface SauceResult {
  readonly title: string;
  readonly author?: string;
  readonly url?: string;
  readonly formattedText: string;
  readonly similarity: number;
}

export class SauceNaoError extends Schema.TaggedError<
  SauceNaoError,
  {
    readonly brand: unique symbol;
  }
>()("SauceNaoError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `SauceNaoError: ${String(this.cause)}`;
  }
}

export const SauceNaoHeaderSchema = Schema.Struct({
  status: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
  minimum_similarity: Schema.optional(
    Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  ),
});

export const SauceNaoItemHeaderSchema = Schema.Struct({
  similarity: Schema.optional(
    Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  ),
  index_id: Schema.optional(Schema.Finite),
});

export const SauceNaoItemDataSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  part: Schema.optional(Schema.String),
  year: Schema.optional(Schema.String),
  material: Schema.optional(Schema.String),
  jp_name: Schema.optional(Schema.String),
  member_name: Schema.optional(Schema.String),
  author_name: Schema.optional(Schema.String),
  creator: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
  twitter_user_name: Schema.optional(Schema.String),
  ext_urls: Schema.optional(Schema.Array(Schema.String)),
  pixiv_id: Schema.optional(
    Schema.Union([Schema.Finite, Schema.FiniteFromString, Schema.String]),
  ),
});

export type SauceNaoItemData = typeof SauceNaoItemDataSchema.Type;

export const SauceNaoItemSchema = Schema.Struct({
  header: Schema.optional(SauceNaoItemHeaderSchema),
  data: Schema.optional(SauceNaoItemDataSchema),
});

export const SauceNaoResponseSchema = Schema.Struct({
  header: Schema.optional(SauceNaoHeaderSchema),
  results: Schema.optional(Schema.Array(SauceNaoItemSchema)),
});

export type SauceNaoResponse = typeof SauceNaoResponseSchema.Type;

const SAUCENAO_API_URL = "https://saucenao.com/search.php";

function extractTitle(data: SauceNaoItemData | undefined): string {
  if (!data) return "未知标题";

  if (typeof data.title === "string" && data.title.trim().length > 0) {
    return data.title.trim();
  }

  if (typeof data.source === "string" && data.source.trim().length > 0) {
    const source = data.source.trim();
    if (typeof data.part === "string" && data.part.trim().length > 0) {
      return `${source} ${data.part.trim()}`;
    }
    return source;
  }

  if (typeof data.material === "string" && data.material.trim().length > 0) {
    return data.material.trim();
  }

  if (typeof data.jp_name === "string" && data.jp_name.trim().length > 0) {
    return data.jp_name.trim();
  }

  return "未知标题";
}

function extractAuthor(data: SauceNaoItemData | undefined): string | undefined {
  if (!data) return undefined;

  const candidates: unknown[] = [
    data.member_name,
    data.author_name,
    Array.isArray(data.creator) ? data.creator[0] : data.creator,
    data.twitter_user_name,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c.trim();
    }
  }

  return undefined;
}

function extractUrl(data: SauceNaoItemData | undefined): string | undefined {
  if (!data) return undefined;

  if (
    Array.isArray(data.ext_urls) &&
    typeof data.ext_urls[0] === "string" &&
    data.ext_urls[0].trim().length > 0
  ) {
    return data.ext_urls[0].trim();
  }

  if (data.pixiv_id !== undefined && data.pixiv_id !== null) {
    return `https://www.pixiv.net/artworks/${data.pixiv_id}`;
  }

  return undefined;
}

export const searchSauce = Effect.fn("SauceNao.searchSauce")(function* (
  imageUrl: string,
  apiKey?: Redacted.Redacted<string>,
  timeoutDuration: Duration.Input = "10 seconds",
): Effect.fn.Return<SauceResult | null, SauceNaoError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;

  const urlParams: Record<string, string> = {
    output_type: "2",
    numres: "1",
    db: "999",
    url: imageUrl,
  };
  if (apiKey) {
    urlParams.api_key = Redacted.value(apiKey);
  }

  const request = HttpClientRequest.get(
    Url.setUrlParams(new URL(SAUCENAO_API_URL), urlParams).toString(),
  );
  const executeAndRead = Effect.gen(function* () {
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new SauceNaoError({ cause })));

    if (response.status < 200 || response.status >= 300) {
      return yield* new SauceNaoError({
        cause: `SauceNao HTTP returned status ${response.status}`,
      });
    }

    const json = yield* HttpClientResponse.schemaBodyJson(
      SauceNaoResponseSchema,
    )(response).pipe(Effect.mapError((cause) => new SauceNaoError({ cause })));

    return json;
  });

  const json = yield* executeAndRead.pipe(
    Effect.timeoutOrElse({
      duration: timeoutDuration,
      orElse: () =>
        new SauceNaoError({
          cause: "SauceNao request timed out",
        }),
    }),
  );
  const status = json.header?.status ?? 0;
  if (status !== 0) {
    return yield* new SauceNaoError({
      cause:
        json.header?.message ??
        `SauceNao API returned non-zero status: ${status}`,
    });
  }

  const results = json.results;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  const first = results[0];
  if (!first) {
    return null;
  }
  const similarity = first.header?.similarity ?? 0;
  const minSimilarity = json.header?.minimum_similarity ?? 0;
  if (similarity < minSimilarity) {
    return null;
  }

  const data = first.data;
  const title = extractTitle(data);
  const author = extractAuthor(data);
  const url = extractUrl(data);

  const titleLine =
    author && author !== title ? `${title} by ${author}` : title;
  const formattedText = url ? `${titleLine}\n${url}` : titleLine;

  return {
    title,
    author,
    url,
    formattedText,
    similarity,
  };
});
