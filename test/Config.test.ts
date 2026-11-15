import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import { BotConfig } from "../src/Config.ts";

describe("BotConfig", () => {
  it("loads configuration and defaults optional keys to undefined", async () => {
    const layer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://127.0.0.1:3001/",
        SNOWLUMA_ACCESS_TOKEN: "test-token",
      }),
    );

    const result = await Effect.runPromise(
      BotConfig.pipe(Effect.provide(layer)),
    );
    expect(result.wsUrl).toBe("ws://127.0.0.1:3001/");
    expect(Redacted.value(result.accessToken)).toBe("test-token");
    expect(result.sauceNaoApiKey).toBeUndefined();
    expect(result.openrouterApiKey).toBeUndefined();
    expect(result.openrouterDecisionModel).toBeUndefined();
    expect(result.openrouterImageModel).toBeUndefined();
    expect(result.devMode).toBe(false);
    expect(result.devGroupId).toBeUndefined();
    expect(result.firecrawlApiKey).toBeUndefined();
    expect(result.danbooruLogin).toBeUndefined();
    expect(result.danbooruApiKey).toBeUndefined();
  });

  it("fails when SNOWLUMA_WS_URL is not provided", async () => {
    const layer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_ACCESS_TOKEN: "test-token",
      }),
    );

    const exit = await Effect.runPromiseExit(
      BotConfig.pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reads all optional environment configs when provided", async () => {
    const config = await Effect.runPromise(
      BotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              SNOWLUMA_WS_URL: "ws://localhost:3001",
              SNOWLUMA_ACCESS_TOKEN: "token",
              SAUCENAO_API_KEY: "my_api_key",
              OPENROUTER_API_KEY: "test_openrouter_key",
              OPENROUTER_DECISION_MODEL: "openai/gpt-6-luna-decisions",
              OPENROUTER_IMAGE_MODEL: "recraft/recraft-v4.1-flash-v2:free",
              DEV_MODE: "true",
              DEV_GROUP_ID: "12345678",
              FIRECRAWL_API_KEY: "fc_test_key",
              DANBOORU_LOGIN: "sakurako_bot",
              DANBOORU_API_KEY: "db_secret_key",
            }),
          ),
        ),
      ),
    );
    expect(config.sauceNaoApiKey).toBeDefined();
    expect(Redacted.value(config.sauceNaoApiKey!)).toBe("my_api_key");
    expect(config.openrouterApiKey).toBeDefined();
    expect(Redacted.value(config.openrouterApiKey!)).toBe(
      "test_openrouter_key",
    );
    expect(config.openrouterDecisionModel).toBe("openai/gpt-6-luna-decisions");
    expect(config.openrouterImageModel).toBe(
      "recraft/recraft-v4.1-flash-v2:free",
    );
    expect(config.devMode).toBe(true);
    expect(config.devGroupId).toBe(12345678);
    expect(config.firecrawlApiKey).toBeDefined();
    expect(Redacted.value(config.firecrawlApiKey!)).toBe("fc_test_key");
    expect(config.danbooruLogin).toBe("sakurako_bot");
    expect(config.danbooruApiKey).toBeDefined();
    expect(Redacted.value(config.danbooruApiKey!)).toBe("db_secret_key");
  });

  it("normalizes empty or whitespace Danbooru credentials to undefined", async () => {
    const config = await Effect.runPromise(
      BotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              SNOWLUMA_WS_URL: "ws://localhost:3001",
              SNOWLUMA_ACCESS_TOKEN: "token",
              DANBOORU_LOGIN: "   ",
              DANBOORU_API_KEY: "  ",
            }),
          ),
        ),
      ),
    );
    expect(config.danbooruLogin).toBeUndefined();
    expect(config.danbooruApiKey).toBeUndefined();
  });

  it("normalizes empty or whitespace OpenRouter credentials and models to undefined", async () => {
    const config = await Effect.runPromise(
      BotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              SNOWLUMA_WS_URL: "ws://localhost:3001",
              SNOWLUMA_ACCESS_TOKEN: "token",
              OPENROUTER_API_KEY: "   ",
              OPENROUTER_DECISION_MODEL: "  ",
              OPENROUTER_IMAGE_MODEL: "\t ",
            }),
          ),
        ),
      ),
    );
    expect(config.openrouterApiKey).toBeUndefined();
    expect(config.openrouterDecisionModel).toBeUndefined();
    expect(config.openrouterImageModel).toBeUndefined();
  });

  it("normalizes empty or whitespace SauceNao API key to undefined", async () => {
    const config = await Effect.runPromise(
      BotConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              SNOWLUMA_WS_URL: "ws://localhost:3001",
              SNOWLUMA_ACCESS_TOKEN: "token",
              SAUCENAO_API_KEY: "   ",
            }),
          ),
        ),
      ),
    );
    expect(config.sauceNaoApiKey).toBeUndefined();
  });
});
