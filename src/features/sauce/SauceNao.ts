/* oxlint-disable effecttsgo/unstable-api-usage */
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { fetchJson } from "../../utils/HttpClient.ts";

export interface SauceResult {
  readonly title: string;
  readonly author?: string;
  readonly url?: string;
  readonly formattedText: string;
  readonly similarity: number;
}

export const TARGET_SAUCENAO_DBS = [
  5, // pixiv
  8, // nico nico seiga
  9, // danbooru
  11, // nijie
  12, // yande.re
  16, // FAKKU
  18, // H-Misc (nhentai)
  21, // Anime
  22, // H-Anime
  25, // Gelbooru
  26, // Konachan
  28, // Anime-Pictures
  37, // MangaDex
  38, // H-Misc (e-hentai)
  44, // Skeb
] as const;
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

const SauceNaoHeaderSchema = Schema.Struct({
  status: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
  minimum_similarity: Schema.optional(
    Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  ),
});

const SauceNaoItemHeaderSchema = Schema.Struct({
  similarity: Schema.optional(
    Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  ),
  index_id: Schema.optional(Schema.Finite),
});

const SauceNaoItemDataSchema = Schema.Struct({
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

type SauceNaoItemData = typeof SauceNaoItemDataSchema.Type;

const SauceNaoItemSchema = Schema.Struct({
  header: Schema.optional(SauceNaoItemHeaderSchema),
  data: Schema.optional(SauceNaoItemDataSchema),
});

const SauceNaoResponseSchema = Schema.Struct({
  header: Schema.optional(SauceNaoHeaderSchema),
  results: Schema.optional(Schema.Array(SauceNaoItemSchema)),
});

const DANBOORU_DB = 9;

const PRIMARY_ORIGIN_DBS = new Set([
  5, // Pixiv
  8, // Nico Nico Seiga
  11, // Nijie
  44, // Skeb
]);

const PREFERRED_BOORU_DBS = new Set([
  9, // Danbooru
  12, // Yande.re
  25, // Gelbooru
  26, // Konachan
  28, // Anime-Pictures
]);

const SIMILARITY_BOORU_TOLERANCE = 2.0;

interface SelectedSauceCandidate {
  readonly urlItem: typeof SauceNaoItemSchema.Type;
  readonly metadataItem: typeof SauceNaoItemSchema.Type;
}

function selectBestSauceResult(
  results: readonly (typeof SauceNaoItemSchema.Type)[] | undefined,
  minSimilarity: number,
): SelectedSauceCandidate | null {
  if (!results || results.length === 0) {
    return null;
  }

  const validCandidates = results.filter((item) => {
    const sim = item.header?.similarity ?? 0;
    return sim >= minSimilarity;
  });

  if (validCandidates.length === 0) {
    return null;
  }

  let highestMatch = validCandidates[0]!;
  let maxSimilarity = highestMatch.header?.similarity ?? 0;

  for (let i = 1; i < validCandidates.length; i++) {
    const item = validCandidates[i]!;
    const sim = item.header?.similarity ?? 0;
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      highestMatch = item;
    }
  }

  const cutoff = maxSimilarity - SIMILARITY_BOORU_TOLERANCE;
  let bestDanbooruCandidate: typeof SauceNaoItemSchema.Type | undefined;
  let bestDanbooruSimilarity = -1;
  let bestOtherBooruCandidate: typeof SauceNaoItemSchema.Type | undefined;
  let bestOtherBooruSimilarity = -1;
  let bestOriginCandidate: typeof SauceNaoItemSchema.Type | undefined;
  let bestOriginSimilarity = -1;

  for (const candidate of validCandidates) {
    const indexId = candidate.header?.index_id;
    const sim = candidate.header?.similarity ?? 0;
    if (indexId !== undefined && sim >= cutoff) {
      if (PREFERRED_BOORU_DBS.has(indexId)) {
        if (indexId === DANBOORU_DB) {
          if (sim > bestDanbooruSimilarity) {
            bestDanbooruSimilarity = sim;
            bestDanbooruCandidate = candidate;
          }
        } else {
          if (sim > bestOtherBooruSimilarity) {
            bestOtherBooruSimilarity = sim;
            bestOtherBooruCandidate = candidate;
          }
        }
      }
      if (PRIMARY_ORIGIN_DBS.has(indexId)) {
        if (sim > bestOriginSimilarity) {
          bestOriginSimilarity = sim;
          bestOriginCandidate = candidate;
        }
      }
    }
  }

  const urlItem =
    bestDanbooruCandidate ?? bestOtherBooruCandidate ?? highestMatch;
  const metadataItem = bestOriginCandidate ?? urlItem;

  return {
    urlItem,
    metadataItem,
  };
}
const SAUCENAO_API_URL = "https://saucenao.com/search.php";

function extractTitle(data: SauceNaoItemData | undefined): string {
  if (!data) return "未知标题";

  if (typeof data.title === "string" && data.title.trim().length > 0) {
    return data.title.trim();
  }

  if (typeof data.source === "string" && data.source.trim().length > 0) {
    const source = data.source.trim();
    if (!source.startsWith("http://") && !source.startsWith("https://")) {
      if (typeof data.part === "string" && data.part.trim().length > 0) {
        return `${source} ${data.part.trim()}`;
      }
      return source;
    }
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
): Effect.fn.Return<SauceResult | null, SauceNaoError, HttpClient.HttpClient> {
  const requestUrl = new URL(SAUCENAO_API_URL);
  requestUrl.searchParams.set("output_type", "2");
  requestUrl.searchParams.set("numres", "5");
  requestUrl.searchParams.set("url", imageUrl);
  for (const db of TARGET_SAUCENAO_DBS) {
    requestUrl.searchParams.append("dbs[]", String(db));
  }
  if (apiKey) {
    requestUrl.searchParams.set("api_key", Redacted.value(apiKey));
  }

  const request = HttpClientRequest.get(requestUrl.toString());
  const json = yield* fetchJson(request, SauceNaoResponseSchema).pipe(
    Effect.mapError(
      (error) =>
        new SauceNaoError({
          cause:
            "status" in error && error.status !== undefined
              ? `SauceNao HTTP returned status ${error.status}`
              : error.message,
        }),
    ),
  );
  const status = json.header?.status ?? 0;
  if (status !== 0) {
    return yield* new SauceNaoError({
      cause:
        json.header?.message ??
        `SauceNao API returned non-zero status: ${status}`,
    });
  }

  const minSimilarity = json.header?.minimum_similarity ?? 0;
  const match = selectBestSauceResult(json.results, minSimilarity);
  if (!match) {
    return null;
  }

  const { urlItem, metadataItem } = match;
  let title = extractTitle(metadataItem.data);
  if (title === "未知标题" && metadataItem !== urlItem) {
    title = extractTitle(urlItem.data);
  }
  const author =
    extractAuthor(metadataItem.data) ?? extractAuthor(urlItem.data);
  const url = extractUrl(urlItem.data);
  const similarity = Math.max(
    metadataItem.header?.similarity ?? 0,
    urlItem.header?.similarity ?? 0,
  );

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
