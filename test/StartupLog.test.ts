import { describe, expect, it } from "bun:test";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import { Effect, Logger, Redacted } from "effect";
import type { BotConfig } from "../src/Config.ts";
import { logStartupInfo } from "../src/index.ts";

describe("logStartupInfo", () => {
  const baseConfig: BotConfig = {
    wsUrl: "ws://127.0.0.1:3001/",
    accessToken: Redacted.make("token"),
    devMode: false,
  };

  const runWithLogger = async (
    effect: Effect.Effect<void, never, never>,
  ): Promise<string[]> => {
    const loggedMessages: string[] = [];
    const testLogger = Logger.make((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.map(String).join(" ")
        : String(options.message);
      loggedMessages.push(msg);
    });

    await Effect.runPromise(
      effect.pipe(Effect.provide(Logger.layer([testLogger]))),
    );
    return loggedMessages;
  };

  it("logs bot nickname and user_id when getLoginInfo succeeds", async () => {
    const mockClient = {
      getLoginInfo: async () => ({
        nickname: "Sakurako",
        user_id: 123456789,
      }),
    } as unknown as SnowLumaWebSocketClient;

    const logs = await runWithLogger(logStartupInfo(mockClient, baseConfig));
    expect(logs).toContain(
      "Sakurako bot listening for messages and notices as Sakurako (123456789)...",
    );
  });

  it("falls back to default message when getLoginInfo fails", async () => {
    const mockClient = {
      getLoginInfo: async () => {
        throw new Error("Network error");
      },
    } as unknown as SnowLumaWebSocketClient;

    const logs = await runWithLogger(logStartupInfo(mockClient, baseConfig));
    expect(logs).toContain(
      "Sakurako bot listening for messages and notices...",
    );
  });

  it("falls back to default message when client is undefined", async () => {
    const logs = await runWithLogger(logStartupInfo(undefined, baseConfig));
    expect(logs).toContain(
      "Sakurako bot listening for messages and notices...",
    );
  });

  it("logs Sauce feature status when sauceNaoApiKey is configured", async () => {
    const configWithSauce: BotConfig = {
      ...baseConfig,
      sauceNaoApiKey: Redacted.make("sauce-key"),
    };

    const logsWithKey = await runWithLogger(
      logStartupInfo(undefined, configWithSauce),
    );
    expect(logsWithKey).toContain(
      "Sauce feature enabled (SauceNao API key configured)",
    );

    const logsWithoutKey = await runWithLogger(
      logStartupInfo(undefined, baseConfig),
    );
    expect(
      logsWithoutKey.some((msg) => msg.includes("Sauce feature enabled")),
    ).toBe(false);
  });

  it("logs decision filter status only when both openrouterApiKey and openrouterDecisionModel are configured", async () => {
    const configWithBoth: BotConfig = {
      ...baseConfig,
      openrouterApiKey: Redacted.make("openrouter-key"),
      openrouterDecisionModel: "custom/model-v1",
    };

    const logsWithBoth = await runWithLogger(
      logStartupInfo(undefined, configWithBoth),
    );
    expect(logsWithBoth).toContain(
      "Decision filter enabled using model custom/model-v1",
    );

    const logsWithKeyOnly = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        openrouterApiKey: Redacted.make("openrouter-key"),
      }),
    );
    expect(
      logsWithKeyOnly.some((msg) => msg.includes("Decision filter enabled")),
    ).toBe(false);

    const logsWithModelOnly = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        openrouterDecisionModel: "custom/model-v1",
      }),
    );
    expect(logsWithModelOnly).toContain(
      "OPENROUTER_DECISION_MODEL is set without OPENROUTER_API_KEY; decision filter disabled",
    );
  });

  it("logs image generation status only when both openrouterApiKey and openrouterImageModel are configured", async () => {
    const logsWithBoth = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        openrouterApiKey: Redacted.make("openrouter-key"),
        openrouterImageModel: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );
    expect(logsWithBoth).toContain(
      "Image generation enabled using model recraft/recraft-v4.1-flash-v2:free",
    );

    const logsWithKeyOnly = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        openrouterApiKey: Redacted.make("openrouter-key"),
      }),
    );
    expect(
      logsWithKeyOnly.some((msg) => msg.includes("Image generation enabled")),
    ).toBe(false);

    const logsWithModelOnly = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        openrouterImageModel: "recraft/recraft-v4.1-flash-v2:free",
      }),
    );
    expect(logsWithModelOnly).toContain(
      "OPENROUTER_IMAGE_MODEL is set without OPENROUTER_API_KEY; /gen command disabled",
    );
  });

  it("logs dev mode and prod mode status", async () => {
    const devConfig: BotConfig = {
      ...baseConfig,
      devMode: true,
      devGroupId: 999888,
    };
    const devLogs = await runWithLogger(logStartupInfo(undefined, devConfig));
    expect(devLogs).toContain(
      "Running in DEV MODE (only group 999888 will be processed)",
    );

    const prodConfigWithDevGroup: BotConfig = {
      ...baseConfig,
      devMode: false,
      devGroupId: 999888,
    };
    const prodLogs = await runWithLogger(
      logStartupInfo(undefined, prodConfigWithDevGroup),
    );
    expect(prodLogs).toContain(
      "Running in PROD MODE (ignoring dev group 999888)",
    );
  });

  it("logs link preview fallback scraper status for keyless and API key modes", async () => {
    const keylessLogs = await runWithLogger(
      logStartupInfo(undefined, baseConfig),
    );
    expect(keylessLogs).toContain(
      "Link preview fallback scraper enabled (Firecrawl keyless mode)",
    );

    const configWithKey: BotConfig = {
      ...baseConfig,
      firecrawlApiKey: Redacted.make("fc-key"),
    };
    const keyLogs = await runWithLogger(
      logStartupInfo(undefined, configWithKey),
    );
    expect(keyLogs).toContain(
      "Link preview fallback scraper enabled (Firecrawl API key configured)",
    );
  });

  it("logs Danbooru status for anonymous, incomplete, and authenticated modes", async () => {
    const anonLogs = await runWithLogger(logStartupInfo(undefined, baseConfig));
    expect(anonLogs).toContain(
      "Danbooru feature enabled (anonymous mode, max 2 tags)",
    );

    const partialLogs = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        danbooruApiKey: Redacted.make("db-key-only"),
      }),
    );
    expect(partialLogs).toContain(
      "Danbooru API credentials incomplete (both DANBOORU_LOGIN and DANBOORU_API_KEY are required); running in anonymous mode (max 2 tags)",
    );

    const authLogs = await runWithLogger(
      logStartupInfo(undefined, {
        ...baseConfig,
        danbooruLogin: "sakurako_bot",
        danbooruApiKey: Redacted.make("db-secret"),
      }),
    );
    expect(authLogs).toContain(
      "Danbooru feature enabled (authenticated as sakurako_bot, max 3 tags)",
    );
    expect(authLogs.some((msg) => msg.includes("db-secret"))).toBe(false);
  });
});
