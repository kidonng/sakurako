import type createMetascraper from "metascraper";
import { Predicate } from "effect";
import type { PageMetadata } from "./LinkPreview.ts";

export type MetascraperRuleContext = createMetascraper.RulesTestOptions;

interface SiteFormatOptions {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
  readonly title?: string;
  readonly description?: string;
}

import { DEFAULT_USER_AGENT } from "../../utils/HttpClient.ts";
export { DEFAULT_USER_AGENT };
export const DANBOORU_USER_AGENT = "Sakurako/1.0  (user #898759)";
export const DEFAULT_ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export interface SiteCustomizer {
  readonly name: string;
  readonly match: (url: URL) => boolean;
  readonly userAgent?: string;
  readonly fetchImageLocally?: boolean;
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
}

export const githubCustomizer: SiteCustomizer = {
  name: "github.com",
  match: (url) => {
    const host = url.hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com";
  },
  formatItem: ({ isSingle }) => ({
    hideDescription: true,
    hideTitle: isSingle,
  }),
};

export const hackerNewsCustomizer: SiteCustomizer = {
  name: "news.ycombinator.com",
  match: (url) => {
    const host = url.hostname.toLowerCase();
    return (
      host === "news.ycombinator.com" || host === "www.news.ycombinator.com"
    );
  },
  formatItem: () => ({
    hideImage: true,
  }),
  metascraperRules: {
    description: ({ htmlDom, url }) => {
      try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.toLowerCase();
        if (
          host !== "news.ycombinator.com" &&
          host !== "www.news.ycombinator.com"
        ) {
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

export const danbooruCustomizer: SiteCustomizer = {
  name: "danbooru.donmai.us",
  match: (url) => {
    const host = url.hostname.toLowerCase();
    return host === "donmai.us" || host.endsWith(".donmai.us");
  },
  userAgent: DANBOORU_USER_AGENT,
  formatItem: () => ({
    hideDescription: true,
  }),
};

const PIXIV_ARTWORKS_REGEX = /^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)(?:\/.*)?$/;

export function extractPixivArtworkId(
  rawUrl: string | URL,
): string | undefined {
  try {
    const url = Predicate.isString(rawUrl) ? new URL(rawUrl) : rawUrl;
    const match = url.pathname.match(PIXIV_ARTWORKS_REGEX);
    if (match?.[1]) {
      return match[1];
    }
    if (url.pathname === "/member_illust.php") {
      const illustId = url.searchParams.get("illust_id");
      if (illustId && /^\d+$/.test(illustId)) {
        return illustId;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const pixivCustomizer: SiteCustomizer = {
  name: "pixiv.net",
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

export function getUserAgent(rawUrl: string | URL): string {
  const customizer = findSiteCustomizer(rawUrl);
  return customizer?.userAgent ?? DEFAULT_USER_AGENT;
}

export function shouldFetchImageLocally(rawUrl: string | URL): boolean {
  const customizer = findSiteCustomizer(rawUrl);
  return customizer?.fetchImageLocally ?? true;
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
