import type createMetascraper from "metascraper";
import type { PageMetadata } from "./LinkPreview.ts";

export type MetascraperRuleContext = createMetascraper.RulesTestOptions;

export interface SiteFormatOptions {
  readonly hideTitle?: boolean;
  readonly hideDescription?: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface SiteCustomizer {
  readonly name: string;
  readonly match: (url: URL) => boolean;
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

export const siteCustomizers: ReadonlyArray<SiteCustomizer> = [
  githubCustomizer,
  hackerNewsCustomizer,
];

export function findSiteCustomizer(rawUrl: string): SiteCustomizer | undefined {
  try {
    const url = new URL(rawUrl);
    return siteCustomizers.find((c) => c.match(url));
  } catch {
    return undefined;
  }
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
