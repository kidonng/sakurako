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

export type MetascraperRuleContext = createMetascraper.RulesTestOptions;

interface SiteFormatOptions {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface SiteCustomizer {
  readonly id: string;
  readonly match: (url: URL) => boolean;
  readonly metascraperRules?: {
    readonly description?: (
      context: MetascraperRuleContext,
    ) => string | undefined;
    readonly title?: (context: MetascraperRuleContext) => string | undefined;
    readonly image?: (context: MetascraperRuleContext) => string | undefined;
    readonly fallbackImage?: (
      context: MetascraperRuleContext,
    ) => string | undefined;
  };
  readonly formatItem?: (params: {
    readonly metadata: PageMetadata;
    readonly isSingle: boolean;
  }) => SiteFormatOptions;
  readonly scrape?: (context: {
    readonly url: URL;
  }) => Effect.Effect<
    PageMetadata | undefined,
    HttpFetchError,
    HttpClient.HttpClient
  >;
}

export const githubCustomizer: SiteCustomizer = {
  id: "github",
  match: (url) => url.hostname.toLowerCase() === "github.com",
  formatItem: ({ isSingle }) => ({
    hideDescription: true,
    hideTitle: isSingle,
  }),
};

export const hackerNewsCustomizer: SiteCustomizer = {
  id: "hacker-news",
  match: (url) => url.hostname.toLowerCase() === "news.ycombinator.com",
  formatItem: () => ({
    hideImage: true,
  }),
  metascraperRules: {
    description: ({ htmlDom, url }) => {
      try {
        const urlObj = new URL(url);
        if (urlObj.hostname.toLowerCase() !== "news.ycombinator.com") {
          return undefined;
        }

        if (urlObj.pathname !== "/item" || !urlObj.searchParams.has("id")) {
          return undefined;
        }

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
  },
};

const DANBOORU_POST_REGEX = /^\/posts\/(\d+)/;

export const danbooruCustomizer: SiteCustomizer = {
  id: "danbooru",
  match: (url) => {
    const host = url.hostname.toLowerCase();
    return host === "donmai.us" || host.endsWith(".donmai.us");
  },
  formatItem: () => ({
    hideDescription: true,
  }),
  scrape: ({ url }) =>
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

const PIXIV_ARTWORKS_REGEX = /^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)(?:\/.*)?$/;

function extractPixivArtworkId(rawUrl: string | URL): string | undefined {
  try {
    const url = Predicate.isString(rawUrl) ? new URL(rawUrl) : rawUrl;
    return url.pathname.match(PIXIV_ARTWORKS_REGEX)?.[1];
  } catch {
    return undefined;
  }
}

export const pixivCustomizer: SiteCustomizer = {
  id: "pixiv",
  match: (url) => {
    const host = url.hostname.toLowerCase();
    return host === "pixiv.net" || host.endsWith(".pixiv.net");
  },
  metascraperRules: {
    image: ({ url }) => {
      const illustId = extractPixivArtworkId(url);
      return illustId ? `https://pixiv.cat/${illustId}.jpg` : undefined;
    },
    fallbackImage: ({ htmlDom, url }) => {
      const illustId = extractPixivArtworkId(url);
      if (!illustId) {
        return undefined;
      }
      return (
        htmlDom('meta[property="og:image"]').attr("content") ||
        htmlDom('meta[property="twitter:image"]').attr("content") ||
        htmlDom('meta[name="twitter:image"]').attr("content")
      );
    },
  },
};

const siteCustomizers: ReadonlyArray<SiteCustomizer> = [
  githubCustomizer,
  hackerNewsCustomizer,
  danbooruCustomizer,
  pixivCustomizer,
];

export function findSiteCustomizer(
  rawUrl: string | URL,
): SiteCustomizer | undefined {
  try {
    const url = Predicate.isString(rawUrl) ? new URL(rawUrl) : rawUrl;
    return siteCustomizers.find((c) => c.match(url));
  } catch {
    return undefined;
  }
}

function createSiteMetascraperPlugin(): () => createMetascraper.Rules {
  return () => ({
    description: [
      ({ htmlDom, url }: MetascraperRuleContext) => {
        const customizer = findSiteCustomizer(url);
        return customizer?.metascraperRules?.description?.({ htmlDom, url });
      },
    ],
    title: [
      ({ htmlDom, url }: MetascraperRuleContext) => {
        const customizer = findSiteCustomizer(url);
        return customizer?.metascraperRules?.title?.({ htmlDom, url });
      },
    ],
    image: [
      ({ htmlDom, url }: MetascraperRuleContext) => {
        const customizer = findSiteCustomizer(url);
        return customizer?.metascraperRules?.image?.({ htmlDom, url });
      },
    ],
    fallbackImage: [
      ({ htmlDom, url }: MetascraperRuleContext) => {
        const customizer = findSiteCustomizer(url);
        return customizer?.metascraperRules?.fallbackImage?.({ htmlDom, url });
      },
    ],
  });
}

export const siteMetascraperPlugin = createSiteMetascraperPlugin();
