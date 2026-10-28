import type createMetascraper from "metascraper";
import type { PageMetadata } from "./LinkPreview.ts";

export type MetascraperRuleContext = createMetascraper.RulesTestOptions;

export interface SiteFormatOptions {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly hideImage?: boolean;
  readonly title?: string;
  readonly description?: string;
}

export const DEFAULT_USER_AGENT = "Sakurako/1.0";
export const DANBOORU_USER_AGENT = "Sakurako/1.0  (user #898759)";

export interface SiteCustomizer {
  readonly name: string;
  readonly match: (url: URL) => boolean;
  readonly userAgent?: string;
  readonly sendImageAsBase64?: boolean;
  readonly metascraperRules?: {
    readonly description?: (
      context: MetascraperRuleContext,
    ) => string | undefined;
    readonly title?: (context: MetascraperRuleContext) => string | undefined;
    readonly image?: (context: MetascraperRuleContext) => string | undefined;
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
  sendImageAsBase64: true,
  formatItem: () => ({
    hideDescription: true,
  }),
};

export const siteCustomizers: ReadonlyArray<SiteCustomizer> = [
  githubCustomizer,
  hackerNewsCustomizer,
  danbooruCustomizer,
];

export function findSiteCustomizer(
  rawUrl: string | URL,
): SiteCustomizer | undefined {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    return siteCustomizers.find((c) => c.match(url));
  } catch {
    return undefined;
  }
}

export function getUserAgent(rawUrl: string | URL): string {
  const customizer = findSiteCustomizer(rawUrl);
  return customizer?.userAgent ?? DEFAULT_USER_AGENT;
}

export function shouldSendImageAsBase64(rawUrl: string | URL): boolean {
  const customizer = findSiteCustomizer(rawUrl);
  return customizer?.sendImageAsBase64 ?? false;
}

export function createSiteMetascraperPlugin(): () => createMetascraper.Rules {
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
  });
}

export const siteMetascraperPlugin = createSiteMetascraperPlugin();
