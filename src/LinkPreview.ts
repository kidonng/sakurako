import { segments } from "@snowluma/sdk/messages";
import type { OutgoingMessage } from "@snowluma/sdk/types";
import { Effect } from "effect";
import getUrls from "get-urls";
import { Address4, Address6 } from "ip-address";
import createMetascraper from "metascraper";
import metascraperDescription from "metascraper-description";
import metascraperImage from "metascraper-image";
import metascraperTitle from "metascraper-title";
import type { IncomingMessage } from "./SnowLuma.ts";
import { truncate } from "./TextWidth.ts";

const scraper = createMetascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperImage(),
]);

export interface PageMetadata {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
}

export type ScrapingResult =
  | { readonly _tag: "Success"; readonly data: PageMetadata }
  | { readonly _tag: "Failure"; readonly url: string; readonly reason: string };

export interface FormattedPreview {
  readonly text: string;
  readonly image?: string;
}

export function formatPreview(
  results: ReadonlyArray<ScrapingResult>,
): FormattedPreview | null {
  if (results.length === 0) {
    return null;
  }

  const allFailed = results.every((r) => r._tag === "Failure");
  if (allFailed) {
    return null;
  }

  const firstResult = results[0];
  if (results.length === 1 && firstResult && firstResult._tag === "Success") {
    const item = firstResult.data;
    const title = truncate(item.title ?? "（无标题）");
    const lines = [title];
    if (item.description) {
      lines.push(truncate(item.description));
    }
    return {
      text: lines.join("\n"),
      image: item.image,
    };
  }

  const blocks: string[] = [];
  let firstImage: string | undefined = undefined;

  results.forEach((item, index) => {
    const num = index + 1;
    if (item._tag === "Failure") {
      blocks.push(`${num}. [提取失败：${item.reason}]`);
    } else {
      const data = item.data;
      const title = truncate(data.title ?? "（无标题）");
      let block = `${num}. ${title}`;
      if (data.description) {
        block += `\n${truncate(data.description)}`;
      }
      blocks.push(block);

      if (!firstImage && data.image) {
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

export function extractUrls(text: string): ReadonlyArray<string> {
  const urls = new Set<string>();
  for (const url of getUrls(text, {
    requireSchemeOrWww: true,
    stripWWW: false,
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
  fetchFn: typeof fetch = fetch,
): Effect.Effect<PageMetadata, string> {
  return Effect.gen(function* () {
    const urlObj = yield* Effect.try({
      try: () => new URL(url),
      catch: (e) => `Invalid URL: ${String(e)}`,
    });

    if (isPrivateHost(urlObj.hostname)) {
      return yield* Effect.fail("Blocked private or local address");
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchFn(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(10000),
        }),
      catch: (error) => `Network error: ${String(error)}`,
    });

    if (!response.ok) {
      return yield* Effect.fail(
        `HTTP ${response.status} ${response.statusText}`.trim(),
      );
    }

    const html = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => `Failed to read response body: ${String(error)}`,
    });

    const metadata = yield* Effect.tryPromise({
      try: () => scraper({ html, url }),
      catch: (error) => `Failed to parse metadata: ${String(error)}`,
    });

    const title = metadata.title?.trim() || undefined;
    const description = metadata.description?.trim() || undefined;
    const image = metadata.image?.trim() || undefined;

    return {
      url,
      title,
      description,
      image,
    };
  });
}

export function scrapeAll(
  urls: ReadonlyArray<string>,
  fetchFn: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ScrapingResult>, never> {
  const effects = urls.map((url) =>
    scrapeMetadata(url, fetchFn).pipe(
      Effect.match({
        onFailure: (reason): ScrapingResult => ({
          _tag: "Failure",
          url,
          reason,
        }),
        onSuccess: (data): ScrapingResult => ({ _tag: "Success", data }),
      }),
    ),
  );
  return Effect.all(effects, { concurrency: "unbounded" });
}

export function handleLinkPreviewMessage(
  item: IncomingMessage,
  fetchFn?: typeof fetch,
): Effect.Effect<void, never> {
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
    yield* Effect.logInfo(
      `Found ${urls.length} URL(s) in message from user ${event.user_id}, scraping preview...`,
    );
    const results = yield* scrapeAll(urls, fetchFn);
    const formatted = formatPreview(results);
    if (!formatted) {
      yield* Effect.logInfo(
        "All URL scrapes failed or produced no preview, remaining silent.",
      );
      return;
    }

    const outgoing: OutgoingMessage = formatted.image
      ? [
          segments.text(formatted.text + (formatted.text ? "\n" : "")),
          segments.image(formatted.image),
        ]
      : segments.text(formatted.text);

    yield* Effect.tryPromise(() => item.context.quote(outgoing));
    yield* Effect.logInfo("Link preview quote reply sent.");
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(`Failed to send link preview reply: ${String(error)}`),
    ),
  );
}
