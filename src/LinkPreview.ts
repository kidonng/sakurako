import { Effect } from "effect"
import getUrls from "get-urls"
import createMetascraper from "metascraper"
import metascraperDescription from "metascraper-description"
import metascraperImage from "metascraper-image"
import metascraperTitle from "metascraper-title"

const scraper = createMetascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperImage()
])

export interface PageMetadata {
  readonly url: string
  readonly title?: string
  readonly description?: string
  readonly image?: string
}

export type ScrapingResult =
  | { readonly _tag: "Success"; readonly data: PageMetadata }
  | { readonly _tag: "Failure"; readonly url: string; readonly reason: string }

export function extractUrls(text: string): ReadonlyArray<string> {
  const urlSet = getUrls(text, { stripWWW: false })
  const result: string[] = []
  for (const url of urlSet) {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      result.push(url)
    }
  }
  return result
}

export function scrapeMetadata(
  url: string,
  fetchFn: typeof fetch = fetch
): Effect.Effect<PageMetadata, string> {
  return Effect.gen(function*() {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchFn(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(10000)
        }),
      catch: (error) => `Network error: ${String(error)}`
    })

    if (!response.ok) {
      return yield* Effect.fail(`HTTP ${response.status} ${response.statusText}`.trim())
    }

    const html = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => `Failed to read response body: ${String(error)}`
    })

    const metadata = yield* Effect.tryPromise({
      try: () => scraper({ html, url }),
      catch: (error) => `Failed to parse metadata: ${String(error)}`
    })

    const title = metadata.title?.trim() || undefined
    const description = metadata.description?.trim() || undefined
    const image = metadata.image?.trim() || undefined

    return {
      url,
      title,
      description,
      image
    }
  })
}

export function scrapeAll(
  urls: ReadonlyArray<string>,
  fetchFn: typeof fetch = fetch
): Effect.Effect<ReadonlyArray<ScrapingResult>, never> {
  const effects = urls.map((url) =>
    scrapeMetadata(url, fetchFn).pipe(
      Effect.match({
        onFailure: (reason): ScrapingResult => ({ _tag: "Failure", url, reason }),
        onSuccess: (data): ScrapingResult => ({ _tag: "Success", data })
      })
    )
  )
  return Effect.all(effects, { concurrency: "unbounded" })
}
