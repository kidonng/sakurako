import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { extractUrls, scrapeAll, scrapeMetadata } from "../src/LinkPreview.ts"

describe("LinkPreviewEngine", () => {
  it("extracts and normalizes URLs from text", () => {
    const text = "Check out https://github.com and http://example.com/test?a=1"
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://github.com", "http://example.com/test?a=1"])
  })

  it("strips trailing punctuation and parentheses from URLs", () => {
    const text = "Visit (https://example.com/doc) and https://example.com/end."
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://example.com/doc", "https://example.com/end"])
  })

  it("deduplicates identical URLs while preserving order", () => {
    const text = "https://example.com https://test.org https://example.com"
    const urls = extractUrls(text)
    expect(urls).toEqual(["https://example.com", "https://test.org"])
  })
  it("ignores scheme-less tokens such as filenames, e-mails, and bare domains", () => {
    const text = "Email me at kid@example.com or read README.md and check config.sh or example.com"
    const urls = extractUrls(text)
    expect(urls).toEqual([])
  })


  it("scrapes metadata from HTML successfully", async () => {
    const mockHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="A cool test page">
          <meta property="og:image" content="https://example.com/cover.png">
        </head>
        <body>Hello</body>
      </html>
    `
    const mockFetch = async () => new Response(mockHtml, { status: 200 })
    const result = await Effect.runPromise(scrapeMetadata("https://example.com", mockFetch as unknown as typeof fetch))

    expect(result.url).toBe("https://example.com")
    expect(result.title).toBe("Test Page")
    expect(result.description).toBe("A cool test page")
    expect(result.image).toBe("https://example.com/cover.png")
  })

  it("handles missing title, description, image gracefully", async () => {
    const mockHtml = "<html><head></head><body>No meta</body></html>"
    const mockFetch = async () => new Response(mockHtml, { status: 200 })
    const result = await Effect.runPromise(scrapeMetadata("https://example.com", mockFetch as unknown as typeof fetch))

    expect(result.url).toBe("https://example.com")
    expect(result.title).toBeUndefined()
    expect(result.description).toBeUndefined()
    expect(result.image).toBeUndefined()
  })

  it("fails when HTTP status is not 200", async () => {
    const mockFetch = async () => new Response("Not Found", { status: 404, statusText: "Not Found" })
    const program = scrapeMetadata("https://example.com/missing", mockFetch as unknown as typeof fetch)
    const error = await Effect.runPromise(program.pipe(Effect.flip))

    expect(error).toContain("HTTP 404")
  })
  it("blocks SSRF attempts on localhost and private IP addresses", async () => {
    const programLocalhost = scrapeMetadata("http://localhost:3000")
    const errorLocalhost = await Effect.runPromise(programLocalhost.pipe(Effect.flip))
    expect(errorLocalhost).toContain("Blocked private or local address")

    const programIp = scrapeMetadata("http://127.0.0.1:8080/secret")
    const errorIp = await Effect.runPromise(programIp.pipe(Effect.flip))
    expect(errorIp).toContain("Blocked private or local address")

    const programPrivate = scrapeMetadata("http://192.168.1.1/admin")
    const errorPrivate = await Effect.runPromise(programPrivate.pipe(Effect.flip))
    expect(errorPrivate).toContain("Blocked private or local address")
  })


  it("scrapeAll aggregates successes and failures concurrently", async () => {
    const mockFetch = async (input: unknown) => {
      const urlStr = String(input)
      if (urlStr.includes("fail")) {
        return new Response("Error", { status: 500 })
      }
      return new Response("<html><head><title>Success Title</title></head></html>", { status: 200 })
    }

    const results = await Effect.runPromise(
      scrapeAll(["https://ok.com", "https://fail.com"], mockFetch as unknown as typeof fetch)
    )

    expect(results).toHaveLength(2)
    const first = results[0]
    const second = results[1]
    expect(first?._tag).toBe("Success")
    if (first?._tag === "Success") {
      expect(first.data.title).toBe("Success Title")
    }
    expect(second?._tag).toBe("Failure")
    if (second?._tag === "Failure") {
      expect(second.url).toBe("https://fail.com")
      expect(second.reason).toContain("HTTP 500")
    }
  })
})
