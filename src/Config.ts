import { Config, Option, type Redacted } from "effect";

export interface BotConfig {
  readonly wsUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly sauceNaoApiKey?: Redacted.Redacted<string>;
  readonly openrouterApiKey?: Redacted.Redacted<string>;
}

export const BotConfig: Config.Config<BotConfig> = Config.all({
  wsUrl: Config.String("SNOWLUMA_WS_URL").pipe(
    Config.withDefault("ws://snowluma.orb.local:3001/"),
  ),
  accessToken: Config.Redacted("SNOWLUMA_ACCESS_TOKEN"),
  sauceNaoApiKey: Config.option(Config.Redacted("SAUCENAO_API_KEY")).pipe(
    Config.map(Option.getOrUndefined),
  ),
  openrouterApiKey: Config.option(Config.Redacted("OPENROUTER_API_KEY")).pipe(
    Config.map(Option.getOrUndefined),
  ),
});
