import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import sharp from "sharp";
import { downloadAndProcessUserImage } from "../../../src/features/link-preview/LinkPreview.ts";
import type { SnowLumaApiClient } from "@snowluma/sdk";

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
        yield* [];
        throw new Error("Stream connection failed");
      },
    } as unknown as SnowLumaApiClient;

    const result = await Effect.runPromise(
      downloadAndProcessUserImage(mockClient, "fail.png"),
    );
    expect(result).toBeUndefined();
  });
});
