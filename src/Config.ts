import { Config, Option, type Redacted } from "effect";

export interface BotConfig {
  readonly wsUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly sauceNaoApiKey?: Redacted.Redacted<string>;
  readonly openrouterApiKey?: Redacted.Redacted<string>;
  readonly devMode: boolean;
  readonly devGroupId?: number;
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
  devMode: Config.Boolean("DEV_MODE").pipe(Config.withDefault(false)),
  devGroupId: Config.option(Config.Int("DEV_GROUP_ID")).pipe(
    Config.map(Option.getOrUndefined),
  ),
});
