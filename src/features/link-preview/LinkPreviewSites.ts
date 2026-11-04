import type createMetascraper from "metascraper";
import { Predicate } from "effect";
import { formatDanbooruTitle } from "../danbooru/DanbooruFormatter.ts";
import { lookupDanbooruTagTranslations } from "../danbooru/DanbooruTagMatcher.ts";
import type { PageMetadata } from "./LinkPreview.ts";

export type MetascraperRuleContext = createMetascraper.RulesTestOptions;

interface SiteFormatOptions {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
  readonly title?: string;
  readonly description?: string;
}

import {
  DANBOORU_USER_AGENT,
  DEFAULT_USER_AGENT,
} from "../../utils/HttpClient.ts";
export { DANBOORU_USER_AGENT, DEFAULT_USER_AGENT };
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

const DANBOORU_POST_REGEX = /^\/posts\/(\d+)/;

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
  metascraperRules: {
    title: ({ htmlDom, url }) => {
      try {
        const urlObj = new URL(url);
        const postMatch = urlObj.pathname.match(DANBOORU_POST_REGEX);
        if (!postMatch || !postMatch[1]) {
          return undefined;
        }

        const postId = Number.parseInt(postMatch[1], 10);
          const charTags: string[] = [];
          htmlDom("ul.character-tag-list li[data-tag-name]").each((_, el) => {
            const tag = htmlDom(el).attr("data-tag-name");
            if (tag) charTags.push(tag);
          });

          const copyTags: string[] = [];
          htmlDom("ul.copyright-tag-list li[data-tag-name]").each((_, el) => {
            const tag = htmlDom(el).attr("data-tag-name");
            if (tag) copyTags.push(tag);
          });

          const artistTags: string[] = [];
          htmlDom("ul.artist-tag-list li[data-tag-name]").each((_, el) => {
            const tag = htmlDom(el).attr("data-tag-name");
            if (tag) artistTags.push(tag);
          });

          if (
            charTags.length > 0 ||
            copyTags.length > 0 ||
            artistTags.length > 0
          ) {
            const allTags = [...charTags, ...copyTags, ...artistTags];
            const translations = lookupDanbooruTagTranslations(allTags);
            return formatDanbooruTitle(
              {
                id: postId,
                tag_string_character: charTags.join(" "),
                tag_string_copyright: copyTags.join(" "),
                tag_string_artist: artistTags.join(" "),
              },
              translations,
            );
          }

        const fallback =
          htmlDom('meta[property="og:title"]').attr("content") ||
          htmlDom('meta[name="twitter:title"]').attr("content") ||
          htmlDom("title").text() ||
          undefined;

        if (fallback) {
          return fallback.replace(/\s*\|\s*Danbooru$/i, "").trim();
        }

        return undefined;
      } catch {
        return undefined;
      }
    },
  },
};

const PIXIV_ARTWORKS_REGEX = /^(?:\/[a-zA-Z-]+)?\/artworks\/(\d+)(?:\/.*)?$/;

export function extractPixivArtworkId(
  rawUrl: string | URL,
): string | undefined {
  try {
    const url = Predicate.isString(rawUrl) ? new URL(rawUrl) : rawUrl;
    return url.pathname.match(PIXIV_ARTWORKS_REGEX)?.[1];
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
