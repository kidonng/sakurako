# Multimodal Link Preview Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate message user images into the OpenRouter Decisions API link preview filtering pipeline, sending compressed image data URLs in the top-level `state` array to enable multimodal decision evaluation.

**Architecture:** Extract image segments from incoming messages, stream image bytes from SnowLuma via `client.downloadFileStream` (`download_file_image_stream`), resize them via `sharp` (max 1000px, JPEG quality 80), sanitize raw CQ codes from `user_message`, and format the OpenRouter Decisions payload as a multimodal top-level `state` array with graceful fallback on download failure.

**Tech Stack:** TypeScript, Bun, Effect 4 (`effect`, `@effect/platform-bun`, `effect/http`), `sharp`, `metascraper`, `bun:test`.

**Spec:** `.superpowers/specs/2026-11-08-multimodal-link-preview-decisions-design.md`

## Global Constraints

- Never use `any` or `as any`.
- Local relative imports MUST include the `.ts` extension (`import { ... } from "./Foo.ts"`).
- Strict Effect 4 error conventions: branded Schema errors using `{ readonly brand: unique symbol }`.
- Follow Linux Kernel commit message style.
- All HTTP requests within Effect programs MUST use `HttpClient.HttpClient` (no global `fetch`).
- Never allow private/loopback IP SSRF requests.

## Review Focus

1. **SnowLuma image stream failure**: If `client.downloadFileStream` throws, times out, or fails during streaming, the pipeline MUST log a warning and safely fall back to text-only state without raising an unhandled error. (Pinned to Task 2)
2. **Corrupted or unreadable image stream**: If the byte stream cannot be decoded by `sharp` or exceeds size limits, it MUST log a warning and fall back to text-only state without failing link preview. (Pinned to Task 2)
3. **CQ code leak into `user_message`**: If the incoming message has `[CQ:image,...]` or `[CQ:at,...]`, raw internal IDs and URLs MUST NOT leak into `state.user_message`; they MUST be sanitized into clean placeholders like `[图片]` and `@用户`. (Pinned to Task 1)
4. **OpenRouter adapter top-level state shape**: Per OpenRouter's `PerplexityDecisionsAdapter` specification, image parts MUST sit directly in the top-level `state` array (`[ { user_message, previews }, { type: "image_url", ... } ]`), never nested inside the state object. (Pinned to Task 3)
5. **No-image backward compatibility**: When a message contains no images, the request payload MUST preserve the existing `state: { user_message, previews }` object structure without regression. (Pinned to Task 3)

---

### Task 1: CQ Code Sanitization & User Image Extraction Utilities

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewSanitizer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function sanitizeUserMessageForDecision(rawMessage: string): string
  export function extractUserImageFiles(message: unknown, rawMessage?: unknown): ReadonlyArray<string>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/link-preview/LinkPreviewSanitizer.test.ts
import { describe, expect, it } from "bun:test";
import {
  extractUserImageUrls,
  sanitizeUserMessageForDecision,
} from "../../../src/features/link-preview/LinkPreview.ts";

describe("LinkPreview Sanitizer & Image Extractor", () => {
  it("sanitizes CQ image and at codes into human placeholders", () => {
    const raw = "check this out https://example.com [CQ:image,file=abc.png,url=https://img.qq.com/abc] [CQ:at,qq=123456]";
    const sanitized = sanitizeUserMessageForDecision(raw);
    expect(sanitized).toBe("check this out https://example.com [图片] @用户");
  });

  it("extracts valid image file identifiers from structured segments or raw message", () => {
    const raw = "https://example.com [CQ:image,file=902FE53EC53AE6E3DFD7C0C6EA11FC96.png,url=https://multimedia.nt.qq.com/img1]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toEqual(["902FE53EC53AE6E3DFD7C0C6EA11FC96.png"]);
  });

  it("limits extracted user image files to at most 1 item", () => {
    const raw = "[CQ:image,file=1.png] [CQ:image,file=2.png]";
    const files = extractUserImageFiles(undefined, raw);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("1.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewSanitizer.test.ts`
Expected: FAIL with "extractUserImageFiles is not a function"

- [ ] **Step 3: Implement `sanitizeUserMessageForDecision` and `extractUserImageFiles` in `src/features/link-preview/LinkPreview.ts`**

Use `parseMessageSegments` from `../../utils/Command.ts` for segment extraction. Filter `type === "image"`, extract `file` string, and slice to max 1 item. Implement regex replacements for `[CQ:image,...]` -> `[图片]` and `[CQ:at,...]` -> `@用户`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewSanitizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewSanitizer.test.ts
git commit -m "link-preview: add CQ code sanitization and user image extraction utilities"
```

---

### Task 2: User Image Download & Sharp Compression Pipeline

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreviewUserImage.test.ts`

**Interfaces:**
- Consumes: `SnowLumaApiClient` from `@snowluma/sdk`
- Produces:
  ```ts
  export const downloadAndProcessUserImage: (
    client: SnowLumaApiClient,
    file: string,
    timeoutDuration?: Duration.Input,
  ) => Effect.Effect<string | undefined>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/features/link-preview/LinkPreviewUserImage.test.ts
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import sharp from "sharp";
import { fetchAndProcessUserImage } from "../../../src/features/link-preview/LinkPreview.ts";
import { makeTestHttpClient } from "../../TestHttpClient.ts";

describe("downloadAndProcessUserImage", () => {
  it("downloads image via downloadFileStream, resizes with sharp and formats as JPEG data URL", async () => {
    const rawPng = await sharp({
      create: {
        width: 1500,
        height: 1200,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const mockClient = {
      downloadFileStream: async function* () {
        yield rawPng;
      },
    } as unknown as SnowLumaApiClient;

    const result = await Effect.runPromise(
      downloadAndProcessUserImage(mockClient, "test.png"),
    );

    expect(result).toBeDefined();
    expect(result!.startsWith("data:image/jpeg;base64,")).toBe(true);

    const base64Data = result!.replace("data:image/jpeg;base64,", "");
    const decoded = Buffer.from(base64Data, "base64");
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBeLessThanOrEqual(1000);
    expect(meta.height).toBeLessThanOrEqual(1000);
    expect(meta.format).toBe("jpeg");
  });

  it("gracefully returns undefined when downloadFileStream throws", async () => {
    const mockClient = {
      downloadFileStream: async function* () {
        throw new Error("Stream connection failed");
      },
    } as unknown as SnowLumaApiClient;

    const result = await Effect.runPromise(
      downloadAndProcessUserImage(mockClient, "fail.png"),
    );
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/LinkPreviewUserImage.test.ts`
Expected: FAIL with "downloadAndProcessUserImage is not defined"

- [ ] **Step 3: Implement `downloadAndProcessUserImage` in `src/features/link-preview/LinkPreview.ts`**

Call `client.downloadFileStream({ file }, { action: "download_file_image_stream" })`. Collect chunks into a Buffer, run `sharp(buffer).resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()`, format as `data:image/jpeg;base64,...`. Catch all errors with `Effect.catch` and return `undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/LinkPreviewUserImage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreviewUserImage.test.ts
git commit -m "link-preview: implement user image download and sharp compression pipeline"
```

---

### Task 3: Multimodal State Serialization in `DecisionFilter.ts`

**Files:**
- Modify: `src/features/link-preview/DecisionFilter.ts`
- Test: `test/features/link-preview/DecisionFilter.test.ts`

**Interfaces:**
- Consumes:
  ```ts
  export interface DecisionsImageUrlPart {
    readonly type: "image_url";
    readonly image_url: { readonly url: string };
  }
  ```
- Produces:
  ```ts
  export const filterPreviewResults: (
    rawMessage: string,
    results: ReadonlyArray<ScrapingResult>,
    apiKey?: Redacted.Redacted<string>,
    model?: string,
    threshold?: number,
    timeoutDuration?: Duration.Input,
    userImages?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// In test/features/link-preview/DecisionFilter.test.ts
// Add tests for multimodal payload construction:
it("serializes state as top-level array with image_url parts when userImages are provided", async () => {
  let capturedBody: any = null;
  const layer = makeTestHttpClient(async (req) => {
    capturedBody = await req.json();
    return new Response(
      JSON.stringify({
        model: "perplexity/pplx-decider-flash-v1.2",
        answers: {
          preview_0: { type: "noul", noul: 0.85 },
        },
      }),
      { status: 200 },
    );
  });

  const previewItem: ScrapingResult = {
    _tag: "Success",
    data: { url: "https://example.com", title: "Example" },
  };

  await Effect.runPromise(
    filterPreviewResults(
      "clean message",
      [previewItem],
      Redacted.make("fake-key"),
      "perplexity/pplx-decider-flash-v1.2",
      0.7,
      "5 seconds",
      ["data:image/jpeg;base64,abc12345"],
    ).pipe(Effect.provide(layer)),
  );

  expect(Array.isArray(capturedBody.state)).toBe(true);
  expect(capturedBody.state).toHaveLength(2);
  expect(capturedBody.state[0].user_message).toBe("clean message");
  expect(capturedBody.state[1]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,abc12345" },
  });
});

it("preserves object state when userImages is empty or undefined", async () => {
  let capturedBody: any = null;
  const layer = makeTestHttpClient(async (req) => {
    capturedBody = await req.json();
    return new Response(
      JSON.stringify({
        model: "perplexity/pplx-decider-flash-v1.2",
        answers: {
          preview_0: { type: "noul", noul: 0.85 },
        },
      }),
      { status: 200 },
    );
  });

  const previewItem: ScrapingResult = {
    _tag: "Success",
    data: { url: "https://example.com", title: "Example" },
  };

  await Effect.runPromise(
    filterPreviewResults(
      "clean message",
      [previewItem],
      Redacted.make("fake-key"),
    ).pipe(Effect.provide(layer)),
  );

  expect(Array.isArray(capturedBody.state)).toBe(false);
  expect(capturedBody.state.user_message).toBe("clean message");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: FAIL due to missing `userImages` parameter or state serialization assertion

- [ ] **Step 3: Update `filterPreviewResults` in `src/features/link-preview/DecisionFilter.ts`**

Update `DecisionsRequest` type to support `state: unknown`. Accept `userImages?: ReadonlyArray<string>`. If `userImages && userImages.length > 0`, construct `state` as `[ { user_message: rawMessage, previews }, ...userImages.map(url => ({ type: "image_url", image_url: { url } })) ]`. Otherwise retain `{ user_message: rawMessage, previews }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/features/link-preview/DecisionFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/DecisionFilter.ts test/features/link-preview/DecisionFilter.test.ts
git commit -m "link-preview: support multimodal image_url state in DecisionFilter"
```

---

### Task 4: Integration in `LinkPreview.ts` & Verification

**Files:**
- Modify: `src/features/link-preview/LinkPreview.ts`
- Test: `test/features/link-preview/LinkPreview.test.ts`

- [ ] **Step 1: Write integration tests in `LinkPreview.test.ts`**

Verify that `handleLinkPreviewMessage` extracts user images from `item.event`, sanitizes CQ codes in `rawMessage`, and passes both to `filterPreviewResults`.

- [ ] **Step 2: Wire `sanitizeUserMessageForDecision`, `extractUserImageFiles`, and `downloadAndProcessUserImage` into `handleLinkPreviewMessage`**

In `src/features/link-preview/LinkPreview.ts`:
1. Check if `openrouterApiKey` is configured.
2. If so, call `extractUserImageFiles(event.message, event.raw_message)`.
3. If an image file is present, call `downloadAndProcessUserImage(item.context.client, imageFile)`.
4. Call `sanitizeUserMessageForDecision(event.raw_message)` as `cleanMessage`.
5. Pass `cleanMessage` and `userImages: processedImage ? [processedImage] : undefined` to `filterPreviewResults`.

- [ ] **Step 3: Run all tests and quality checks**

Run:
```bash
bun test
bun run check
bun run lint
```
Expected: All pass without errors or type warnings.

- [ ] **Step 4: Real Smoke Verification**

Run throwaway smoke script using `~/Downloads/902FE53EC53AE6E3DFD7C0C6EA11FC96.png` with live OpenRouter Decisions API:
```bash
bun -e '...test script...'
```
Verify that passing the incident screenshot lowers the score significantly below 0.57 (confirming confident filtering of redundant incident card).

- [ ] **Step 5: Commit**

```bash
git add src/features/link-preview/LinkPreview.ts test/features/link-preview/LinkPreview.test.ts
git commit -m "link-preview: wire user message images into decision filter pipeline"
```
