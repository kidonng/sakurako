import { describe, expect, it } from "bun:test";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import { Effect, Logger, Redacted } from "effect";
import type { BotConfig } from "../src/Config.ts";
import { logStartupInfo } from "../src/index.ts";

describe("logStartupInfo", () => {
  const baseConfig: BotConfig = {
    wsUrl: "ws://127.0.0.1:3001/",
    accessToken: Redacted.make("token"),
    openrouterDecisionModel: "~typesafe/jev-latest",
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

  it("logs decision filter status and model when openrouterApiKey is configured", async () => {
    const configWithOpenRouter: BotConfig = {
      ...baseConfig,
      openrouterApiKey: Redacted.make("openrouter-key"),
      openrouterDecisionModel: "custom/model-v1",
    };

    const logsWithKey = await runWithLogger(
      logStartupInfo(undefined, configWithOpenRouter),
    );
    expect(logsWithKey).toContain(
      "Decision filter enabled using model custom/model-v1",
    );

    const logsWithoutKey = await runWithLogger(
      logStartupInfo(undefined, baseConfig),
    );
    expect(
      logsWithoutKey.some((msg) => msg.includes("Decision filter enabled")),
    ).toBe(false);
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
});
