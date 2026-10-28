import { describe, expect, it } from "bun:test"
import type { SnowLumaEventContextWithQuote } from "@snowluma/sdk"
import type { OneBotMessageEvent } from "@snowluma/sdk/types"
import { Effect } from "effect"
import { handleIncomingMessage } from "../src/EchoBot.ts"
import type { IncomingMessage } from "../src/SnowLuma.ts"

describe("handleIncomingMessage", () => {
  it("replies with 喵喵喵 when raw_message is strictly 喵喵喵 in a group", async () => {
    let replied: unknown = null
    const item: IncomingMessage = {
      event: {
        raw_message: "喵喵喵",
        message_type: "group",
        user_id: 10001,
        group_id: 20002
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async (msg: unknown) => {
          replied = msg
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(replied).toBe("喵喵喵")
  })

  it("replies with 喵喵喵 when raw_message is strictly 喵喵喵 in private chat", async () => {
    let replied: unknown = null
    const item: IncomingMessage = {
      event: {
        raw_message: "喵喵喵",
        message_type: "private",
        user_id: 10001
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async (msg: unknown) => {
          replied = msg
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(replied).toBe("喵喵喵")
  })

  it("does not reply when message contains whitespace", async () => {
    let called = false
    const item: IncomingMessage = {
      event: {
        raw_message: " 喵喵喵 ",
        message_type: "group",
        user_id: 10001
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async () => {
          called = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(called).toBe(false)
  })

  it("does not reply when message is different text or prefix", async () => {
    let called = false
    const item: IncomingMessage = {
      event: {
        raw_message: "喵喵",
        message_type: "private",
        user_id: 10001
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async () => {
          called = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(called).toBe(false)
  })

  it("does not reply when message is sent by the bot itself (message_sent)", async () => {
    let called = false
    const item: IncomingMessage = {
      event: {
        raw_message: "喵喵喵",
        post_type: "message_sent",
        message_type: "group",
        user_id: 2840296514,
        self_id: 2840296514
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async () => {
          called = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(called).toBe(false)
  })

  it("does not reply when user_id equals self_id", async () => {
    let called = false
    const item: IncomingMessage = {
      event: {
        raw_message: "喵喵喵",
        post_type: "message",
        message_type: "group",
        user_id: 2840296514,
        self_id: 2840296514
      } as unknown as OneBotMessageEvent,
      context: {
        reply: async () => {
          called = true
        }
      } as unknown as SnowLumaEventContextWithQuote<OneBotMessageEvent>
    }

    await Effect.runPromise(handleIncomingMessage(item))
    expect(called).toBe(false)
  })
})
