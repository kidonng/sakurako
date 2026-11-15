import { Config, Option, Redacted } from "effect";

export const ANONYMOUS_DANBOORU_TAG_LIMIT = 2;
export const MEMBER_DANBOORU_TAG_LIMIT = 3;

export interface DanbooruAuthConfig {
  readonly danbooruLogin?: string;
  readonly danbooruApiKey?: Redacted.Redacted<string>;
}

export interface ImageGenConfig {
  readonly openrouterApiKey?: Redacted.Redacted<string>;
  readonly openrouterImageModel?: string;
}

export interface SauceNaoConfig {
  readonly sauceNaoApiKey?: Redacted.Redacted<string>;
}

export interface BotConfig
  extends DanbooruAuthConfig, ImageGenConfig, SauceNaoConfig {
  readonly wsUrl: string;
  readonly accessToken: Redacted.Redacted<string>;
  readonly openrouterDecisionModel?: string;
  readonly devMode: boolean;
  readonly devGroupId?: number;
  readonly firecrawlApiKey?: Redacted.Redacted<string>;
}

const trimmedOptionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((opt) => Option.getOrUndefined(opt)?.trim() || undefined),
  );

const trimmedOptionalRedacted = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(
    Config.map((opt) => {
      const value = Option.getOrUndefined(opt);
      if (!value) {
        return undefined;
      }
      const trimmed = Redacted.value(value).trim();
      return trimmed.length > 0 ? Redacted.make(trimmed) : undefined;
    }),
  );

const danbooruLoginConfig = trimmedOptionalString("DANBOORU_LOGIN");
const danbooruApiKeyConfig = trimmedOptionalRedacted("DANBOORU_API_KEY");
const openrouterApiKeyConfig = trimmedOptionalRedacted("OPENROUTER_API_KEY");
const sauceNaoApiKeyConfig = trimmedOptionalRedacted("SAUCENAO_API_KEY");
const openrouterDecisionModelConfig = trimmedOptionalString(
  "OPENROUTER_DECISION_MODEL",
);
const openrouterImageModelConfig = trimmedOptionalString(
  "OPENROUTER_IMAGE_MODEL",
);

export const ImageGenConfig: Config.Config<ImageGenConfig> = Config.all({
  openrouterApiKey: openrouterApiKeyConfig,
  openrouterImageModel: openrouterImageModelConfig,
});

export const DanbooruAuthConfig: Config.Config<DanbooruAuthConfig> = Config.all(
  {
    danbooruLogin: danbooruLoginConfig,
    danbooruApiKey: danbooruApiKeyConfig,
  },
);

export const SauceNaoConfig: Config.Config<SauceNaoConfig> = Config.all({
  sauceNaoApiKey: sauceNaoApiKeyConfig,
});

export function resolveDanbooruCredentials(config?: DanbooruAuthConfig):
  | {
      readonly login: string;
      readonly apiKey: Redacted.Redacted<string>;
    }
  | undefined {
  const login = config?.danbooruLogin?.trim();
  const apiKey = config?.danbooruApiKey;
  const apiKeyValue = apiKey ? Redacted.value(apiKey).trim() : "";
  if (!login || !apiKeyValue) {
    return undefined;
  }
  return {
    login,
    apiKey: Redacted.make(apiKeyValue),
  };
}

export function hasIncompleteDanbooruCredentials(
  config?: DanbooruAuthConfig,
): boolean {
  const hasLogin = Boolean(config?.danbooruLogin?.trim());
  const hasApiKey = Boolean(
    config?.danbooruApiKey && Redacted.value(config.danbooruApiKey).trim(),
  );
  return hasLogin !== hasApiKey;
}

export function getDanbooruTagLimit(config?: DanbooruAuthConfig): number {
  return resolveDanbooruCredentials(config)
    ? MEMBER_DANBOORU_TAG_LIMIT
    : ANONYMOUS_DANBOORU_TAG_LIMIT;
}

export const BotConfig: Config.Config<BotConfig> = Config.all({
  wsUrl: Config.String("SNOWLUMA_WS_URL"),
  accessToken: Config.Redacted("SNOWLUMA_ACCESS_TOKEN"),
  sauceNaoApiKey: sauceNaoApiKeyConfig,
  openrouterApiKey: openrouterApiKeyConfig,
  openrouterDecisionModel: openrouterDecisionModelConfig,
  openrouterImageModel: openrouterImageModelConfig,
  devMode: Config.Boolean("DEV_MODE").pipe(Config.withDefault(false)),
  devGroupId: Config.option(Config.Int("DEV_GROUP_ID")).pipe(
    Config.map(Option.getOrUndefined),
  ),
  firecrawlApiKey: Config.option(Config.Redacted("FIRECRAWL_API_KEY")).pipe(
    Config.map(Option.getOrUndefined),
  ),
  danbooruLogin: danbooruLoginConfig,
  danbooruApiKey: danbooruApiKeyConfig,
});
