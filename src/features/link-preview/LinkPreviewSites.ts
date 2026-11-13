/* oxlint-disable effecttsgo/unstable-api-usage */
import type createMetascraper from "metascraper";
import { Effect, Predicate } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { resolveDanbooruTitle } from "../danbooru/DanbooruFormatter.ts";
import {
  DanbooruPostSchema,
  withDanbooruUserAgent,
} from "../danbooru/DanbooruClient.ts";
import type { PageMetadata } from "./LinkPreview.ts";
import { fetchJson, type HttpFetchError } from "../../utils/HttpClient.ts";

function parseUrlSafe(rawUrl: string | URL): URL | undefined {
  if (!Predicate.isString(rawUrl)) {
    return rawUrl;
  }
  try {
    return new URL(rawUrl);
  } catch {
    return undefined;
  }
}

function isDonmaiHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "donmai.us" || host.endsWith(".donmai.us");
}

function isPixivHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "pixiv.net" || host.endsWith(".pixiv.net");
}

// ============================================================================
// Stage 1: Pre-fetch site scrapers
// ============================================================================

interface SiteScraper {
  readonly id: string;
  readonly match: (url: URL) => boolean;
  readonly scrape: (
    url: URL,
  ) => Effect.Effect<
    PageMetadata | undefined,
    HttpFetchError,
    HttpClient.HttpClient
  >;
}

const DANBOORU_POST_REGEX = /^\/posts\/(\d+)/;

export const danbooruPostScraper: SiteScraper = {
  id: "danbooru-post",
  match: (url) => isDonmaiHost(url) && DANBOORU_POST_REGEX.test(url.pathname),
  scrape: (url) =>
    Effect.gen(function* () {
      const postMatch = url.pathname.match(DANBOORU_POST_REGEX);
      if (!postMatch || !postMatch[1]) {
        return undefined;
      }

      const jsonUrl = `${url.origin}/posts/${postMatch[1]}.json`;
      const request = HttpClientRequest.get(jsonUrl).pipe(
        withDanbooruUserAgent,
        HttpClientRequest.acceptJson,
      );

      const post = yield* fetchJson(request, DanbooruPostSchema);

      const title = yield* resolveDanbooruTitle(post);
      const image = post.large_file_url ?? post.file_url;
      const fallbackImage = post.preview_file_url;

      return {
        url: url.href,
        title,
        image,
        fallbackImage,
      };
    }).pipe(
      Effect.catchTag(
        [
          "HttpNoContentError",
          "HttpRateLimitError",
          "HttpTimeoutError",
          "HttpNetworkError",
        ],
        () => Effect.succeed(undefined as PageMetadata | undefined),
      ),
    ),
};

const siteScrapers: ReadonlyArray<SiteScraper> = [danbooruPostScraper];

export function scrapeWithSiteOverride(
  url: URL,
): Effect.Effect<
  PageMetadata | undefined,
  HttpFetchError,
  HttpClient.HttpClient
> {
  const scraper = siteScrapers.find((entry) => entry.match(url));
  return scraper
    ? scraper.scrape(url)
    : Effect.succeed(undefined as PageMetadata | undefined);
}
// ============================================================================
// Stage 2: Native metascraper HTML extraction rules
// ============================================================================

export const hackerNewsRules = {
  pkgName: "site:hacker-news",
  test: ({ url }: createMetascraper.RulesTestOptions) => {
    const urlObj = parseUrlSafe(url);
    return Boolean(
      urlObj &&
      urlObj.hostname.toLowerCase() === "news.ycombinator.com" &&
      urlObj.pathname === "/item" &&
      urlObj.searchParams.has("id"),
    );
  },
  description: ({ htmlDom, url }: createMetascraper.RulesTestOptions) => {
    try {
      const titleline = htmlDom(".titleline");
      if (titleline.length === 0) {
        return undefined;
      }

      const titleAnchor = titleline.find("a").first();
      const href = titleAnchor.attr("href");
      if (!href) {
        return undefined;
      }

      const targetUrl = new URL(href, url);
      const targetHost = targetUrl.hostname.toLowerCase();
      const isHnHost =
        targetHost === "news.ycombinator.com" ||
        targetHost === "ycombinator.com";

      if (isHnHost && targetUrl.pathname === "/item") {
        return undefined;
      }

      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return undefined;
      }

      return targetUrl.href;
    } catch {
      return undefined;
    }
  },
} satisfies createMetascraper.Rules;

const PIXIV_ARTWORKS_REGEX = /^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)(?:\/.*)?$/;

function extractPixivArtworkId(rawUrl: string | URL): string | undefined {
  const url = parseUrlSafe(rawUrl);
  return url?.pathname.match(PIXIV_ARTWORKS_REGEX)?.[1];
}

export const pixivRules = {
  pkgName: "site:pixiv",
  test: ({ url }: createMetascraper.RulesTestOptions) => {
    const urlObj = parseUrlSafe(url);
    return Boolean(
      urlObj && isPixivHost(urlObj) && extractPixivArtworkId(urlObj),
    );
  },
  image: ({ url }: createMetascraper.RulesTestOptions) => {
    const illustId = extractPixivArtworkId(url);
    return illustId ? `https://pixiv.cat/${illustId}.jpg` : undefined;
  },
  fallbackImage: ({ htmlDom }: createMetascraper.RulesTestOptions) => {
    return (
      htmlDom('meta[property="og:image"]').attr("content") ||
      htmlDom('meta[property="twitter:image"]').attr("content") ||
      htmlDom('meta[name="twitter:image"]').attr("content")
    );
  },
} satisfies createMetascraper.Rules;

export const siteMetascraperRules: ReadonlyArray<createMetascraper.Rules> = [
  hackerNewsRules,
  pixivRules,
];

// ============================================================================
// Stage 3: Post-scrape display policies
// ============================================================================

export interface SiteDisplayPolicy {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
}

interface SiteDisplayRule {
  readonly id: string;
  readonly match: (url: URL) => boolean;
  readonly getPolicy: (context: {
    readonly isSingle: boolean;
  }) => SiteDisplayPolicy;
}

const githubDisplayRule: SiteDisplayRule = {
  id: "github",
  match: (url) => url.hostname.toLowerCase() === "github.com",
  getPolicy: ({ isSingle }) => ({
    hideDescription: true,
    hideTitle: isSingle,
  }),
};

const hackerNewsDisplayRule: SiteDisplayRule = {
  id: "hacker-news",
  match: (url) => url.hostname.toLowerCase() === "news.ycombinator.com",
  getPolicy: () => ({
    hideImage: true,
  }),
};

const danbooruDisplayRule: SiteDisplayRule = {
  id: "danbooru",
  match: isDonmaiHost,
  getPolicy: () => ({
    hideDescription: true,
  }),
};

const siteDisplayRules: ReadonlyArray<SiteDisplayRule> = [
  githubDisplayRule,
  hackerNewsDisplayRule,
  danbooruDisplayRule,
];

export function getSiteDisplayPolicy(
  rawUrl: string | URL,
  context: { readonly isSingle: boolean },
): SiteDisplayPolicy | undefined {
  const url = parseUrlSafe(rawUrl);
  if (!url) {
    return undefined;
  }
  return siteDisplayRules.find((rule) => rule.match(url))?.getPolicy(context);
}
