/* oxlint-disable effecttsgo/unstable-api-usage */
import { segments } from "@snowluma/sdk/messages";
import type { OutgoingMessage } from "@snowluma/sdk/types";
import { Data, type Duration, Effect } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import getUrls from "get-urls";
import { Address4, Address6 } from "ip-address";
import createMetascraper from "metascraper";
import metascraperDescription from "metascraper-description";
import metascraperImage from "metascraper-image";
import metascraperTitle from "metascraper-title";
import {
  DEFAULT_ACCEPT_HEADER,
  findSiteCustomizer,
  getUserAgent,
  type MetascraperRuleContext,
  shouldSendImageAsBase64,
  siteMetascraperPlugin,
} from "./LinkPreviewSites.ts";
import { filterPreviewResults } from "./JevFilter.ts";
import { BotConfig } from "../../Config.ts";
import type { IncomingMessage } from "../../SnowLuma.ts";
import {
  formatLogMessagePrefix,
  formatLogSnippet,
} from "../../utils/LogFormat.ts";
import { truncate } from "../../utils/TextWidth.ts";

const NOISE_CONTAINERS = "header, footer, nav, aside, form, dialog";

export function extractFirstParagraph(
  $: MetascraperRuleContext["htmlDom"],
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

export function firstParagraphPlugin(): createMetascraper.Rules {
  return {
    description: [
      ({ htmlDom }: MetascraperRuleContext) => extractFirstParagraph(htmlDom),
    ],
  };
}

const scraper = createMetascraper([
  siteMetascraperPlugin(),
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
}

export class InvalidUrlError extends Data.TaggedError("InvalidUrlError")<{
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid URL: ${String(this.cause)}`;
  }
}

export class BlockedHostError extends Data.TaggedError("BlockedHostError")<{
  readonly url: string;
  readonly hostname: string;
}> {
  override readonly message = "Blocked private or local address";
}

export class HttpFetchError extends Data.TaggedError("HttpFetchError")<{
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly detail: string;
}> {
  override get message(): string {
    if (this.status !== undefined) {
      return `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`.trim();
    }
    return `Network error: ${this.detail}`;
  }
}

export class ParseMetadataError extends Data.TaggedError("ParseMetadataError")<{
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to parse metadata: ${String(this.cause)}`;
  }
}

export type ScrapeMetadataError =
  InvalidUrlError | BlockedHostError | HttpFetchError | ParseMetadataError;

export type ScrapingResult =
  | { readonly _tag: "Success"; readonly data: PageMetadata }
  | { readonly _tag: "Filtered"; readonly url: string }
  | {
      readonly _tag: "Failure";
      readonly url: string;
      readonly error: ScrapeMetadataError;
    };
export interface FormattedPreview {
  readonly text: string;
  readonly image?: string;
}

export class SendLinkPreviewReplyError extends Data.TaggedError(
  "SendLinkPreviewReplyError",
)<{
  readonly cause: unknown;
}> {}

export class DownloadImageAsBase64Error extends Data.TaggedError(
  "DownloadImageAsBase64Error",
)<{
  readonly cause: unknown;
}> {}

export function isSvgUrl(url: string): boolean {
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

export function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause instanceof Error) {
      return `${error.stack ?? error.message}\nCaused by: ${error.cause.stack ?? error.cause.message}`;
    }
    return error.stack ?? error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause instanceof Error
  ) {
    return error.cause.stack ?? error.cause.message;
  }
  return String(error);
}

export function formatPreview(
  results: ReadonlyArray<ScrapingResult>,
): FormattedPreview | null {
  if (results.length === 0) {
    return null;
  }

  const hasValidPreview = results.some((r) => {
    if (r._tag !== "Success") return false;
    const customizer = findSiteCustomizer(r.data.url);
    const options = customizer?.formatItem?.({
      metadata: r.data,
      isSingle: results.length === 1,
    });
    const title = !options?.hideTitle && (options?.title ?? r.data.title);
    const image =
      !options?.hideImage && r.data.image && !isSvgUrl(r.data.image);
    return Boolean(title || image);
  });
  if (!hasValidPreview) {
    return null;
  }

  const firstResult = results[0];
  if (results.length === 1 && firstResult && firstResult._tag === "Success") {
    const item = firstResult.data;
    const customizer = findSiteCustomizer(item.url);
    const options = customizer?.formatItem?.({
      metadata: item,
      isSingle: true,
    });

    const lines: string[] = [];
    if (!options?.hideTitle) {
      const rawTitle = options?.title ?? item.title;
      if (rawTitle) {
        lines.push(truncate(rawTitle));
      }
    }
    if (!options?.hideDescription) {
      const rawDescription = options?.description ?? item.description;
      if (rawDescription) {
        lines.push(`> ${truncate(rawDescription)}`);
      }
    }

    const rawImage = options?.hideImage ? undefined : item.image;
    const image = rawImage && !isSvgUrl(rawImage) ? rawImage : undefined;

    const text = lines.join("\n");
    if (!text && !image) {
      return null;
    }

    return {
      text,
      image,
    };
  }

  const blocks: string[] = [];
  let firstImage: string | undefined = undefined;

  results.forEach((item, index) => {
    const num = index + 1;
    if (item._tag === "Filtered") {
      blocks.push(`${num}. （已过滤）`);
    } else if (item._tag === "Failure") {
      blocks.push(`${num}. [提取失败：${item.error.message}]`);
    } else {
      const data = item.data;
      const customizer = findSiteCustomizer(data.url);
      const options = customizer?.formatItem?.({
        metadata: data,
        isSingle: false,
      });

      const rawTitle = options?.title ?? data.title;
      if (rawTitle) {
        let block = `${num}. ${truncate(rawTitle)}`;
        if (!options?.hideDescription) {
          const rawDescription = options?.description ?? data.description;
          if (rawDescription) {
            block += `\n> ${truncate(rawDescription)}`;
          }
        }
        blocks.push(block);
      } else {
        blocks.push(`${num}. [提取失败：未获取到网页标题]`);
      }

      if (
        !firstImage &&
        !options?.hideImage &&
        data.image &&
        !isSvgUrl(data.image)
      ) {
        firstImage = data.image;
      }
    }
  });

  return {
    text: blocks.join("\n"),
    image: firstImage,
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
        (stripped.match(/\]/g)?.length ?? 0);
    const next = balanced ? stripped : stripped.replace(/[)\]]$/, "");
    if (next === cleaned) {
      return cleaned;
    }
    cleaned = next;
  }
}

function stripCqCodes(text: string): string {
  return text.replace(/\[CQ:[^\]]+\]/g, " ");
}

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

export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
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

export function scrapeMetadata(
  url: string,
  timeoutDuration: Duration.Input = "10 seconds",
): Effect.Effect<PageMetadata, ScrapeMetadataError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

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

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)),
      HttpClientRequest.setHeader("Accept", DEFAULT_ACCEPT_HEADER),
    );
    const { html, targetUrl } = yield* Effect.gen(function* () {
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        const webRes = HttpClientResponse.toWeb(response);
        const statusText =
          webRes._tag === "Some" && webRes.value.statusText
            ? webRes.value.statusText
            : undefined;
        if (webRes._tag === "Some") {
          void webRes.value.body?.cancel().catch(() => {});
        }
        return yield* new HttpFetchError({
          url,
          status: response.status,
          statusText,
          detail: `HTTP status ${response.status}`,
        });
      }
      const html = yield* response.text;
      const targetUrl = response.url || url;
      return { html, targetUrl };
    }).pipe(
      Effect.timeout(timeoutDuration),
      Effect.mapError((error) =>
        error._tag === "HttpFetchError"
          ? error
          : new HttpFetchError({
              url,
              detail: error.message,
            }),
      ),
    );
    const metadata = yield* Effect.tryPromise({
      try: () => scraper({ html, url: targetUrl }),
      catch: (cause) => new ParseMetadataError({ url, cause }),
    });

    const title = metadata.title?.trim() || undefined;
    const description = metadata.description?.trim() || undefined;
    const rawImage = metadata.image?.trim() || undefined;
    const image = rawImage && !isSvgUrl(rawImage) ? rawImage : undefined;

    return {
      url,
      title,
      description,
      image,
    };
  });
}

export function prepareOutgoingImage(
  imageUrl: string,
  timeoutDuration: Duration.Input = "10 seconds",
): Effect.Effect<string | undefined, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const urlObj = yield* Effect.try({
      try: () => new URL(imageUrl),
      catch: (e) => `Invalid URL: ${String(e)}`,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Blocked private or invalid image URL: ${imageUrl} (${error})`,
        ).pipe(Effect.as(undefined)),
      ),
    );

    if (!urlObj || isPrivateHost(urlObj.hostname)) {
      if (urlObj) {
        yield* Effect.logWarning(
          `Blocked private or invalid image URL: ${imageUrl}`,
        );
      }
      return undefined;
    }

    if (!shouldSendImageAsBase64(imageUrl)) {
      return imageUrl;
    }

    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(imageUrl).pipe(
      HttpClientRequest.setHeader("User-Agent", getUserAgent(urlObj)),
    );

    const downloadEffect = Effect.gen(function* () {
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        const webRes = HttpClientResponse.toWeb(response);
        const statusText =
          webRes._tag === "Some" && webRes.value.statusText
            ? webRes.value.statusText
            : "";
        if (webRes._tag === "Some") {
          void webRes.value.body?.cancel().catch(() => {});
        }
        return yield* new DownloadImageAsBase64Error({
          cause: new Error(
            `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`.trim(),
          ),
        });
      }
      const buffer = yield* response.arrayBuffer;
      const base64 = Buffer.from(buffer).toString("base64");
      return `base64://${base64}` as string | undefined;
    }).pipe(
      Effect.timeout(timeoutDuration),
      Effect.catchTag("DownloadImageAsBase64Error", (error) =>
        Effect.logWarning(
          `Failed to download image as base64 for ${imageUrl}: ${formatErrorDetail(error.cause)}`,
        ).pipe(Effect.as(undefined as string | undefined)),
      ),
      Effect.catch((error) =>
        Effect.logWarning(
          `Failed to download image as base64 for ${imageUrl}: ${formatErrorDetail(error)}`,
        ).pipe(Effect.as(undefined as string | undefined)),
      ),
    );

    return yield* downloadEffect;
  });
}

export function scrapeAll(
  urls: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient> {
  const effects = urls.map((url) =>
    scrapeMetadata(url).pipe(
      Effect.match({
        onFailure: (error): ScrapingResult => ({
          _tag: "Failure",
          url,
          error,
        }),
        onSuccess: (data): ScrapingResult => ({ _tag: "Success", data }),
      }),
    ),
  );
  return Effect.all(effects, { concurrency: "unbounded" });
}

export function handleLinkPreviewMessage(
  item: IncomingMessage,
): Effect.Effect<void, never, HttpClient.HttpClient> {
  const { event } = item;
  if (
    event.post_type === "message_sent" ||
    event.user_id === event.self_id ||
    !event.raw_message
  ) {
    return Effect.void;
  }

  const urls = extractUrls(event.raw_message);
  if (urls.length === 0) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const prefix = formatLogMessagePrefix(event);
    const snippet = formatLogSnippet(event.raw_message);
    yield* Effect.logInfo(
      `${prefix} Found ${urls.length} URL(s) in message "${snippet}", scraping preview...`,
    );
    const results = yield* scrapeAll(urls);
    const config = yield* Effect.option(BotConfig);
    const openrouterApiKey =
      config._tag === "Some" ? config.value.openrouterApiKey : undefined;
    const filteredResults = yield* filterPreviewResults(
      event.raw_message,
      results,
      openrouterApiKey,
    );
    const formatted = formatPreview(filteredResults);
    if (!formatted || (!formatted.text && !formatted.image)) {
      yield* Effect.logInfo(
        `${prefix} All URL scrapes failed or produced no preview, remaining silent.`,
      );
      return;
    }

    const resolvedImage = formatted.image
      ? yield* prepareOutgoingImage(formatted.image)
      : undefined;

    const buildOutgoing = (image?: string): OutgoingMessage =>
      image
        ? formatted.text
          ? [segments.text(formatted.text + "\n"), segments.image(image)]
          : [segments.image(image)]
        : segments.text(formatted.text);

    const outgoing = buildOutgoing(resolvedImage);

    yield* Effect.tryPromise({
      try: () => item.context.quote(outgoing),
      catch: (cause) => new SendLinkPreviewReplyError({ cause }),
    }).pipe(
      Effect.catch((error) => {
        if (resolvedImage && formatted.text) {
          return Effect.logWarning(
            `Failed to send quote reply with image, falling back to text-only: ${formatErrorDetail(error.cause)}`,
          ).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => item.context.quote(buildOutgoing(undefined)),
                catch: (fallbackCause) =>
                  new SendLinkPreviewReplyError({ cause: fallbackCause }),
              }),
            ),
          );
        }
        return Effect.fail(error);
      }),
    );
    yield* Effect.logInfo(`${prefix} Link preview quote reply sent.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(
        `${formatLogMessagePrefix(event)} Failed to send link preview reply for ${urls.join(", ")}: ${formatErrorDetail(error.cause)}`,
      ),
    ),
  );
}
