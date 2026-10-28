/* oxlint-disable effecttsgo/unstable-api-usage */
import { Data, Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export interface SauceResult {
  readonly title: string;
  readonly author?: string;
  readonly url?: string;
  readonly formattedText: string;
  readonly similarity: number;
}

export class SauceNaoError extends Data.TaggedError("SauceNaoError")<{
  readonly cause: unknown;
}> {}

interface SauceNaoHeader {
  readonly status?: number;
  readonly message?: string;
  readonly minimum_similarity?: number | string;
}

interface SauceNaoItemHeader {
  readonly similarity?: string | number;
  readonly index_id?: number;
}

interface SauceNaoItemData {
  readonly title?: string;
  readonly source?: string;
  readonly part?: string;
  readonly year?: string;
  readonly material?: string;
  readonly jp_name?: string;
  readonly member_name?: string;
  readonly author_name?: string;
  readonly creator?: string | string[];
  readonly twitter_user_name?: string;
  readonly ext_urls?: string[];
  readonly pixiv_id?: number | string;
}

interface SauceNaoItem {
  readonly header?: SauceNaoItemHeader;
  readonly data?: SauceNaoItemData;
}

interface SauceNaoResponse {
  readonly header?: SauceNaoHeader;
  readonly results?: SauceNaoItem[];
}

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

export function searchSauce(
  imageUrl: string,
  apiKey?: Redacted.Redacted<string>,
): Effect.Effect<SauceResult | null, SauceNaoError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const requestUrl = new URL(SAUCENAO_API_URL);
    requestUrl.searchParams.set("output_type", "2");
    requestUrl.searchParams.set("numres", "1");
    requestUrl.searchParams.set("db", "999");
    requestUrl.searchParams.set("url", imageUrl);

    if (apiKey) {
      requestUrl.searchParams.set("api_key", Redacted.value(apiKey));
    }

    const request = HttpClientRequest.get(requestUrl.toString());

    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) => new SauceNaoError({ cause })),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* new SauceNaoError({
        cause: `SauceNao HTTP returned status ${response.status}`,
      });
    }

    const json = (yield* response.json.pipe(
      Effect.mapError((cause) => new SauceNaoError({ cause })),
    )) as SauceNaoResponse;

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
    const similarityRaw = first.header?.similarity;
    const similarity =
      typeof similarityRaw === "number"
        ? similarityRaw
        : parseFloat(similarityRaw ?? "0");

    const minSimilarityRaw = json.header?.minimum_similarity;
    const minSimilarity =
      typeof minSimilarityRaw === "number"
        ? minSimilarityRaw
        : parseFloat(minSimilarityRaw ?? "0");

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
}
