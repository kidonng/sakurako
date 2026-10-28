import { describe, expect, it } from "bun:test"
import { ConfigProvider, Effect, Redacted } from "effect"
import { BotConfig } from "../src/Config.ts"

describe("BotConfig", () => {
  it("loads configuration from environment provider", async () => {
    const layer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_WS_URL: "ws://127.0.0.1:3001/",
        SNOWLUMA_ACCESS_TOKEN: "test-token"
      })
    )

    const result = await Effect.runPromise(
      BotConfig.pipe(Effect.provide(layer))
    )
    expect(result.wsUrl).toBe("ws://127.0.0.1:3001/")
    expect(Redacted.value(result.accessToken)).toBe("test-token")
  })

  it("uses default wsUrl if not provided", async () => {
    const layer = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SNOWLUMA_ACCESS_TOKEN: "test-token"
      })
    )

    const result = await Effect.runPromise(
      BotConfig.pipe(Effect.provide(layer))
    )
    expect(result.wsUrl).toBe("ws://snowluma.orb.local:3001/")
    expect(Redacted.value(result.accessToken)).toBe("test-token")
  })
})
