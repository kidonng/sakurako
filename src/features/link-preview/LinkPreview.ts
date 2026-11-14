/* oxlint-disable effecttsgo/unstable-api-usage */
import { segments } from "@snowluma/sdk/messages";
import type { OutgoingMessage } from "@snowluma/sdk/types";
import {
  type SnowLumaApiClient,
  SnowLumaApiError,
  SnowLumaMediaSendError,
} from "@snowluma/sdk";
import sharp from "sharp";
import {
  Data,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  fetchImage,
  fetchText,
  type HttpFetchError,
} from "../../utils/HttpClient.ts";
import getUrls from "get-urls";
import { Address4, Address6 } from "ip-address";
import createMetascraper from "metascraper";
import metascraperDescription from "metascraper-description";
import metascraperImage from "metascraper-image";
import metascraperTitle from "metascraper-title";
import {
  getSiteDisplayPolicy,
  scrapeWithSiteOverride,
  siteMetascraperRules,
} from "./LinkPreviewSites.ts";
import {
  FallbackScraper,
  type FallbackScrapeResult,
} from "./FallbackScraper.ts";
import { filterPreviewResults } from "./DecisionFilter.ts";
import { BotConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import {
  formatErrorDetail,
  formatLogMessagePrefix,
  formatLogSnippet,
} from "../../utils/LogFormat.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
import { extractMessageImages } from "../../utils/Command.ts";
import { truncate } from "../../utils/TextWidth.ts";

const NOISE_CONTAINERS = "header, footer, nav, aside, form, dialog";

export function extractFirstParagraph(
  $: createMetascraper.RulesTestOptions["htmlDom"],
): string | undefined {
  const findIn = (selector: string): string | undefined => {
    for (const el of $(selector).toArray()) {
      const $el = $(el);
      if ($el.closest(NOISE_CONTAINERS).length > 0) {
        continue;
      }
      const $clone = $el.clone();
      $clone.find("br").replaceWith(" ");
      const text = $clone.text().replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        return text;
      }
    }
    return undefined;
  };

  return findIn('article p, main p, [role="main"] p') ?? findIn("p");
}

function firstParagraphPlugin(): createMetascraper.Rules {
  return {
    description: [
      ({ htmlDom }: createMetascraper.RulesTestOptions) =>
        extractFirstParagraph(htmlDom),
    ],
  };
}

const scraper = createMetascraper([
  ...siteMetascraperRules,
  metascraperTitle(),
  metascraperDescription(),
  firstParagraphPlugin(),
  metascraperImage(),
]);

export interface PageMetadata {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  readonly fallbackImage?: string;
}

class InvalidUrlError extends Schema.TaggedError<
  InvalidUrlError,
  {
    readonly brand: unique symbol;
  }
>()("InvalidUrlError", {
  url: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Invalid URL: ${this.url} (${String(this.cause)})`;
  }
}

export class BlockedHostError extends Schema.TaggedError<
  BlockedHostError,
  {
    readonly brand: unique symbol;
  }
>()("BlockedHostError", {
  url: Schema.String,
  hostname: Schema.String,
}) {
  override get message(): string {
    return "Blocked private or local address";
  }
}

class ParseMetadataError extends Schema.TaggedError<
  ParseMetadataError,
  {
    readonly brand: unique symbol;
  }
>()("ParseMetadataError", {
  url: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to parse metadata: ${String(this.cause)}`;
  }
}

class ProcessUserImageError extends Schema.TaggedError<
  ProcessUserImageError,
  {
    readonly brand: unique symbol;
  }
>()("ProcessUserImageError", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to download and process user image ${this.file}: ${String(this.cause)}`;
  }
}
type ScrapeMetadataError =
  InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError;

export const DEFAULT_DESCRIPTION_MAX_WIDTH = 100;
const EXPANDED_DESCRIPTION_MAX_WIDTH = 280;

export type ScrapingResult = Data.TaggedEnum<{
  Success: {
    readonly data: PageMetadata;
    readonly expanded?: boolean;
  };
  Filtered: { readonly url: string };
  Failure: {
    readonly url: string;
    readonly error: ScrapeMetadataError;
  };
}>;

const {
  Success: ScrapingSuccess,
  Filtered: ScrapingFiltered,
  Failure: ScrapingFailure,
  $is: isScrapingResult,
} = Data.taggedEnum<ScrapingResult>();

export { isScrapingResult, ScrapingFiltered };
export interface FormattedPreview {
  readonly text: string;
  readonly image?: string;
  readonly fallbackImage?: string;
}

class SendLinkPreviewReplyError extends Schema.TaggedError<
  SendLinkPreviewReplyError,
  {
    readonly brand: unique symbol;
  }
>()("SendLinkPreviewReplyError", {
  cause: Schema.Defect(),
}) {}

const DEFAULT_IMAGE_TIMEOUT: Duration.Input = "5 seconds";

function isSvgUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:") {
      return parsed.pathname.toLowerCase().startsWith("image/svg+xml");
    }
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith(".svg") || pathname.endsWith(".svgz");
  } catch {
    const lower = url.toLowerCase();
    return (
      lower.startsWith("data:image/svg+xml") ||
      lower.endsWith(".svg") ||
      lower.endsWith(".svgz")
    );
  }
}

function prepareEffectiveScrapingResults(
  results: ReadonlyArray<ScrapingResult>,
  isSingle: boolean,
): ReadonlyArray<ScrapingResult> {
  const isSuccess = isScrapingResult("Success");
  return results.map((result) => {
    if (!isSuccess(result)) {
      return result;
    }
    const item = result.data;
    const policy = getSiteDisplayPolicy(item.url, { isSingle });

    const title = policy?.hideTitle ? undefined : item.title;
    const description = policy?.hideDescription ? undefined : item.description;
    const image =
      policy?.hideImage || (item.image && isSvgUrl(item.image))
        ? undefined
        : item.image;
    const fallbackImage =
      policy?.hideImage || (item.fallbackImage && isSvgUrl(item.fallbackImage))
        ? undefined
        : item.fallbackImage;

    return {
      ...result,
      data: {
        ...item,
        title,
        description,
        image,
        fallbackImage,
      },
    };
  });
}

export function formatPreview(
  results: ReadonlyArray<ScrapingResult>,
): FormattedPreview | null {
  if (results.length === 0) {
    return null;
  }
  const isSuccess = isScrapingResult("Success");
  const effectiveResults = prepareEffectiveScrapingResults(
    results,
    results.length === 1,
  );

  const hasValidPreview = effectiveResults.some((r) => {
    if (!isSuccess(r)) return false;
    return Boolean(r.data.title || r.data.image);
  });
  if (!hasValidPreview) {
    return null;
  }

  const firstResult = effectiveResults[0];
  if (effectiveResults.length === 1 && firstResult && isSuccess(firstResult)) {
    const item = firstResult.data;
    const lines: string[] = [];
    if (item.title) {
      lines.push(truncate(item.title));
    }
    if (item.description) {
      const descWidth = firstResult.expanded
        ? EXPANDED_DESCRIPTION_MAX_WIDTH
        : DEFAULT_DESCRIPTION_MAX_WIDTH;
      lines.push(`> ${truncate(item.description, descWidth)}`);
    }

    const text = lines.join("\n");
    if (!text && !item.image) {
      return null;
    }

    return {
      text,
      image: item.image,
      ...(item.fallbackImage ? { fallbackImage: item.fallbackImage } : {}),
    };
  }

  const blocks: string[] = [];
  let firstImage: string | undefined = undefined;
  let firstFallbackImage: string | undefined = undefined;

  effectiveResults.forEach((item, index) => {
    const num = index + 1;
    const block = Match.valueTags(item, {
      Filtered: () => `${num}. [已过滤]`,
      Failure: ({ error }) => `${num}. [提取失败：${error.message}]`,
      Success: ({ data, expanded }) => {
        let line: string;
        if (data.title) {
          line = `${num}. ${truncate(data.title)}`;
          if (data.description) {
            const descWidth = expanded
              ? EXPANDED_DESCRIPTION_MAX_WIDTH
              : DEFAULT_DESCRIPTION_MAX_WIDTH;
            line += `\n> ${truncate(data.description, descWidth)}`;
          }
        } else {
          line = `${num}. [提取失败：未获取到网页标题]`;
        }

        if (!firstImage && data.image) {
          firstImage = data.image;
          firstFallbackImage = data.fallbackImage;
        }
        return line;
      },
    });
    blocks.push(block);
  });

  return {
    text: blocks.join("\n"),
    image: firstImage,
    ...(firstFallbackImage ? { fallbackImage: firstFallbackImage } : {}),
  };
}

function trimTrailingUrlPunctuation(url: string): string {
  let cleaned = url;
  while (true) {
    const stripped = cleaned.replace(/[.,;!?]+$/, "");
    const balanced =
      (stripped.match(/\(/g)?.length ?? 0) >=
        (stripped.match(/\)/g)?.length ?? 0) &&
      (stripped.match(/\[/g)?.length ?? 0) >=
        (stripped.match(/]/g)?.length ?? 0);
    const next = balanced ? stripped : stripped.replace(/[)\]]$/, "");
    if (next === cleaned) {
      return cleaned;
    }
    cleaned = next;
  }
}

function stripCqCodes(text: string): string {
  return text.replace(/\[CQ:[^\]]+]/g, " ");
}

export function sanitizeUserMessageForDecision(rawMessage: string): string {
  return rawMessage
    .replace(/\[CQ:image,[^\]]+]/g, "[图片]")
    .replace(/\[CQ:at,[^\]]+]/g, "@用户")
    .replace(/\[CQ:[^\]]+]/g, "")
    .trim();
}

export function extractUserImageFiles(
  message: unknown,
  rawMessage?: unknown,
  limit: number = 1,
): ReadonlyArray<string> {
  return extractMessageImages(message, rawMessage, limit).map(
    (img) => img.target,
  );
}

export const downloadAndProcessUserImage = Effect.fnUntraced(function* (
  client: SnowLumaApiClient,
  file: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of client.downloadFileStream(
        { file },
        { action: "download_file_image_stream" },
      )) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const processed = await sharp(buffer)
        .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      return `data:image/jpeg;base64,${processed.toString("base64")}`;
    },
    catch: (cause) => new ProcessUserImageError({ file, cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(error.message).pipe(
        Effect.as(undefined as string | undefined),
      ),
    ),
  );
});

export function extractUrls(text: string): ReadonlyArray<string> {
  const urls = new Set<string>();
  for (const url of getUrls(stripCqCodes(text), {
    requireSchemeOrWww: true,
    stripWWW: false,
    removeTrailingSlash: false,
  })) {
    const cleaned = trimTrailingUrlPunctuation(url);
    if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
      urls.add(cleaned);
    }
  }
  return [...urls];
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|]$/g, "");
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    return true;
  }

  if (Address4.isValid(lower)) {
    return !new Address4(lower).isGlobal();
  }

  if (Address6.isValid(lower)) {
    return !new Address6(lower).isGlobal();
  }

  return false;
}

const DEFAULT_ACCEPT_HEADER = "text/html";

export function shouldTriggerFallback(error: ScrapeMetadataError): boolean {
  switch (error._tag) {
    case "HttpRateLimitError":
    case "HttpTimeoutError":
    case "HttpNetworkError":
      return true;
    case "InvalidUrlError":
    case "BlockedHostError":
    case "HttpNotFoundError":
    case "HttpNoContentError":
    case "ParseMetadataError":
      return false;
  }
}

const parseHtmlMetadata = Effect.fnUntraced(function* (
  originalUrl: string,
  html: string,
  targetUrl: string,
): Effect.fn.Return<PageMetadata, ParseMetadataError> {
  const metadata = yield* Effect.tryPromise({
    try: () => scraper({ html, url: targetUrl }),
    catch: (cause) => new ParseMetadataError({ url: originalUrl, cause }),
  });

  const title = metadata.title?.trim() || undefined;
  const description = metadata.description?.trim() || undefined;
  const rawImage = metadata.image?.trim() || undefined;
  const image = rawImage && !isSvgUrl(rawImage) ? rawImage : undefined;
  const rawFallback =
    (
      metadata as unknown as Record<string, string | undefined>
    ).fallbackImage?.trim() || undefined;
  const fallbackImage =
    rawFallback && !isSvgUrl(rawFallback) ? rawFallback : undefined;

  return {
    url: originalUrl,
    title,
    description,
    image,
    fallbackImage,
  };
});

const buildMetadataFromFallback = Effect.fnUntraced(function* (
  originalUrl: string,
  fallback: FallbackScrapeResult,
): Effect.fn.Return<PageMetadata, ParseMetadataError> {
  const fallbackImage =
    fallback.metadata?.image && !isSvgUrl(fallback.metadata.image)
      ? fallback.metadata.image
      : undefined;

  if (fallback.html) {
    const parsed = yield* parseHtmlMetadata(
      originalUrl,
      fallback.html,
      fallback.url,
    );
    return {
      url: originalUrl,
      title: parsed.title ?? fallback.metadata?.title,
      description: parsed.description ?? fallback.metadata?.description,
      image: parsed.image ?? fallbackImage,
      ...(parsed.fallbackImage ? { fallbackImage: parsed.fallbackImage } : {}),
    };
  }

  return {
    url: originalUrl,
    title: fallback.metadata?.title,
    description: fallback.metadata?.description,
    image: fallbackImage,
  };
});

export const scrapeMetadata = Effect.fn("LinkPreview.scrapeMetadata")(
  function* (
    url: string,
  ): Effect.fn.Return<
    PageMetadata,
    ScrapeMetadataError,
    HttpClient.HttpClient
  > {
    const urlObj = yield* Effect.try({
      try: () => new URL(url),
      catch: (cause) => new InvalidUrlError({ url, cause }),
    });

    if (isPrivateHost(urlObj.hostname)) {
      return yield* new BlockedHostError({
        url,
        hostname: urlObj.hostname,
      });
    }

    const customMetadata = yield* scrapeWithSiteOverride(urlObj);
    if (customMetadata) {
      return customMetadata;
    }

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.accept(DEFAULT_ACCEPT_HEADER),
    );
    const localResult = yield* fetchText(request).pipe(
      Effect.flatMap(({ text: html, url: targetUrl }) =>
        parseHtmlMetadata(url, html, targetUrl),
      ),
      Effect.result,
    );

    if (localResult._tag === "Success") {
      return localResult.success;
    }

    const localError = localResult.failure;
    if (!shouldTriggerFallback(localError)) {
      return yield* localError;
    }

    const fallbackOpt = yield* Effect.serviceOption(FallbackScraper);
    if (Option.isNone(fallbackOpt)) {
      return yield* localError;
    }

    yield* Effect.logInfo(
      `Local fetch failed for ${url} (${localError.message}), trying fallback scraper...`,
    );

    const fallbackResult = yield* fallbackOpt.value
      .scrape(url)
      .pipe(Effect.result);

    if (fallbackResult._tag === "Failure") {
      yield* Effect.logWarning(
        `Fallback scraper failed for ${url}: ${fallbackResult.failure.message}`,
      );
      return yield* localError;
    }

    return yield* buildMetadataFromFallback(url, fallbackResult.success).pipe(
      Effect.catch((parseError) =>
        Effect.logWarning(
          `Failed to parse fallback metadata for ${url}: ${parseError.message}`,
        ).pipe(Effect.andThen(Effect.fail(localError))),
      ),
    );
  },
);

export interface PrepareImageOptions {
  readonly fallbackImageUrl?: string;
  readonly timeoutDuration?: Duration.Input;
}

const DEFAULT_RATE_LIMIT_MAX_RETRIES = 2;
const DEFAULT_RATE_LIMIT_BASE_DELAY: Duration.Input = "1 second";
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 10_000;

const imageRateLimitSchedule = Schedule.exponential(
  DEFAULT_RATE_LIMIT_BASE_DELAY,
).pipe(
  Schedule.upTo({ times: DEFAULT_RATE_LIMIT_MAX_RETRIES }),
  Schedule.setInputType<HttpFetchError>(),
  Schedule.while(({ input }) => {
    if (input._tag !== "HttpRateLimitError") {
      return false;
    }
    return (
      input.retryAfterMs === undefined ||
      input.retryAfterMs <= DEFAULT_RATE_LIMIT_MAX_DELAY_MS
    );
  }),
  Schedule.modifyDelay(({ duration, input }) => {
    const fallbackMs = Duration.toMillis(duration);
    const delayMs =
      input._tag === "HttpRateLimitError" && input.retryAfterMs !== undefined
        ? Math.min(
            Math.max(0, input.retryAfterMs),
            DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
          )
        : Math.min(fallbackMs, DEFAULT_RATE_LIMIT_MAX_DELAY_MS);
    return Effect.succeed(Duration.millis(delayMs));
  }),
  Schedule.tap((meta) =>
    Effect.logInfo(
      `Rate limited fetching image (${meta.input.url}), retrying in ${Duration.toMillis(meta.duration)}ms...`,
    ),
  ),
);

const downloadSingleImage = Effect.fnUntraced(function* (
  targetUrl: string,
  timeoutDuration: Duration.Input,
) {
  const urlObj = yield* Effect.try({
    try: () => new URL(targetUrl),
    catch: (e) => `Invalid URL: ${String(e)}`,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Blocked private or invalid image URL: ${targetUrl} (${error})`,
      ).pipe(Effect.as(undefined)),
    ),
  );

  if (!urlObj || isPrivateHost(urlObj.hostname)) {
    if (urlObj) {
      yield* Effect.logWarning(
        `Blocked private or invalid image URL: ${targetUrl}`,
      );
    }
    return undefined;
  }

  const request = HttpClientRequest.get(targetUrl);

  return yield* fetchImage(request, { timeoutDuration }).pipe(
    Effect.retry(imageRateLimitSchedule),
    Effect.catch((error) =>
      Effect.logWarning(
        `Failed to fetch image locally for ${targetUrl}: ${formatErrorDetail(error)}`,
      ).pipe(Effect.as(undefined as string | undefined)),
    ),
  );
});

function isPrepareImageOptions(
  options: unknown,
): options is PrepareImageOptions {
  return (
    Predicate.isObject(options) &&
    ("fallbackImageUrl" in options || "timeoutDuration" in options)
  );
}

export const prepareOutgoingImage = Effect.fn(
  "LinkPreview.prepareOutgoingImage",
)(function* (
  imageUrl: string,
  options?: PrepareImageOptions | Duration.Input,
): Effect.fn.Return<string | undefined, never, HttpClient.HttpClient> {
  const isOptions = isPrepareImageOptions(options);
  const timeoutDuration: Duration.Input = isOptions
    ? (options.timeoutDuration ?? DEFAULT_IMAGE_TIMEOUT)
    : (options ?? DEFAULT_IMAGE_TIMEOUT);

  const fallbackImageUrl: string | undefined = isOptions
    ? options.fallbackImageUrl
    : undefined;
  const primaryResult = yield* downloadSingleImage(imageUrl, timeoutDuration);
  if (primaryResult) {
    return primaryResult;
  }

  if (fallbackImageUrl) {
    yield* Effect.logWarning(
      `Primary image failed for ${imageUrl}, falling back to ${fallbackImageUrl}...`,
    );
    return yield* downloadSingleImage(fallbackImageUrl, timeoutDuration);
  }

  return undefined;
});

export function scrapeAll(
  urls: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient> {
  return Effect.forEach(
    urls,
    (url) =>
      scrapeMetadata(url).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logWarning(
              `Failed to scrape metadata for ${url}: ${error.message}`,
            ).pipe(Effect.as(ScrapingFailure({ url, error }))),
          onSuccess: (data) => Effect.succeed(ScrapingSuccess({ data })),
        }),
      ),
    { concurrency: "unbounded" },
  );
}

export const handleLinkPreviewMessage = Effect.fnUntraced(function* (
  item: IncomingMessage,
) {
  const { event } = item;
  if (isSelfMessage(event) || !event.raw_message) {
    return;
  }

  const urls = extractUrls(event.raw_message);
  if (urls.length === 0) {
    return;
  }

  const sendPreview = Effect.gen(function* () {
    const prefix = formatLogMessagePrefix(event);
    const snippet = formatLogSnippet(event.raw_message);
    yield* Effect.logInfo(
      `${prefix} Found ${urls.length} URL(s) in message "${snippet}", scraping preview...`,
    );
    const results = yield* scrapeAll(urls);
    const config = yield* Effect.option(BotConfig);
    const openrouterApiKey = Option.getOrUndefined(config)?.openrouterApiKey;
    const openrouterDecisionModel =
      Option.getOrUndefined(config)?.openrouterDecisionModel;
    let userImages: string[] | undefined;
    if (openrouterApiKey && openrouterDecisionModel?.trim()) {
      const imageFiles = extractUserImageFiles(
        event.message,
        event.raw_message,
      );
      if (imageFiles.length > 0 && item.context.client) {
        const firstFile = imageFiles[0]!;
        const processed = yield* downloadAndProcessUserImage(
          item.context.client,
          firstFile,
        );
        if (processed) {
          userImages = [processed];
        }
      }
    }
    const effectiveResults = prepareEffectiveScrapingResults(
      results,
      results.length === 1,
    );
    const cleanUserMessage = sanitizeUserMessageForDecision(event.raw_message);
    const filteredResults = yield* filterPreviewResults(
      cleanUserMessage,
      effectiveResults,
      openrouterApiKey,
      openrouterDecisionModel,
      undefined,
      userImages,
    );
    const formatted = formatPreview(filteredResults);
    if (!formatted || (!formatted.text && !formatted.image)) {
      yield* Effect.logInfo(
        `${prefix} All URL scrapes failed or produced no preview, remaining silent.`,
      );
      return;
    }

    const resolvedImage = formatted.image
      ? yield* prepareOutgoingImage(formatted.image, {
          fallbackImageUrl: formatted.fallbackImage,
        })
      : undefined;

    if (!formatted.text && !resolvedImage) {
      yield* Effect.logInfo(
        `${prefix} Link preview image failed to download and no text remains, remaining silent.`,
      );
      return;
    }

    const buildOutgoing = (image?: string): OutgoingMessage =>
      image
        ? formatted.text
          ? [segments.text(formatted.text + "\n"), segments.image(image)]
          : [segments.image(image)]
        : segments.text(formatted.text);

    const outgoing = buildOutgoing(resolvedImage);

    yield* Effect.tryPromise({
      try: () => item.context.reply(outgoing),
      catch: (cause) => new SendLinkPreviewReplyError({ cause }),
    }).pipe(
      Effect.catch((error) => {
        const isDefinitiveFailure =
          error.cause instanceof SnowLumaApiError ||
          (error.cause instanceof SnowLumaMediaSendError &&
            error.cause.stage === "upload");
        if (resolvedImage && formatted.text && isDefinitiveFailure) {
          return Effect.logWarning(
            `Failed to send reply with image, falling back to text-only: ${formatErrorDetail(error.cause)}`,
          ).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => item.context.reply(buildOutgoing(undefined)),
                catch: (fallbackCause) =>
                  new SendLinkPreviewReplyError({ cause: fallbackCause }),
              }),
            ),
          );
        }
        return Effect.fail(error);
      }),
    );
    yield* Effect.logInfo(`${prefix} Link preview reply sent.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(
        `${formatLogMessagePrefix(event)} Failed to send link preview reply for ${urls.join(", ")}: ${formatErrorDetail(error.cause)}`,
      ),
    ),
  );

  yield* sendPreview;
});
