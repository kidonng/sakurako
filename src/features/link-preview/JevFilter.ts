/* oxlint-disable effecttsgo/unstable-api-usage */
import { Data, type Duration, Effect, Redacted } from "effect";
import stringWidth from "string-width";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  DEFAULT_DESCRIPTION_MAX_WIDTH,
  type PageMetadata,
  type ScrapingResult,
} from "./LinkPreview.ts";
import { truncate } from "../../utils/TextWidth.ts";

export const OPENROUTER_SYSTEMONE_URL =
  "https://openrouter.ai/api/v1/systemone";
export const DEFAULT_JEV_MODEL = "~typesafe/jev-latest";
export const DEFAULT_THRESHOLD = 0.7;
export const DEFAULT_TIMEOUT: Duration.Input = "10 seconds";

export interface SystemOneNoulCriteria {
  readonly true: string;
  readonly false: string;
}

export interface SystemOneNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: SystemOneNoulCriteria;
}

export interface SystemOneRequest {
  readonly model: string;
  readonly state: {
    readonly user_message: string;
    readonly previews: Record<
      string,
      {
        readonly url: string;
        readonly title?: string;
        readonly description?: string;
        readonly standard_truncated?: string;
      }
    >;
  };
  readonly questions: Record<string, SystemOneNoulQuestion>;
}

export interface SystemOneAnswer {
  readonly type?: string;
  readonly noul?: number;
}

export interface SystemOneResponse {
  readonly model?: string;
  readonly answers?: Record<string, SystemOneAnswer>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cost?: number;
  };
}

export class JevFilterError extends Data.TaggedError("JevFilterError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `JevFilterError: ${String(this.cause)}`;
  }
}

const NOUL_INSTRUCTIONS =
  "Does the preview for this link provide substantive, valuable, and non-redundant information beyond what is already conveyed in the user message?";

const NOUL_CRITERIA: SystemOneNoulCriteria = {
  true: "The preview provides meaningful context, new facts, or substantial details not already present in the user message, and is not promotional boilerplate, generic site greetings, or channel ads.",
  false:
    "The preview merely repeats information already stated in the user message, or consists of generic site slogans, channel/group promo links, submission bots, or empty boilerplate.",
};

const NOUL_SUFFICIENT_CRITERIA: SystemOneNoulCriteria = {
  true: "The standard truncated excerpt already conveys meaningful new facts not present in user_message.",
  false:
    "The standard truncated excerpt merely repeats what was in user_message, while any new facts only exist further down in description or are absent entirely.",
};
export function filterPreviewResults(
  rawMessage: string,
  results: ReadonlyArray<ScrapingResult>,
  apiKey?: Redacted.Redacted<string>,
  threshold: number = DEFAULT_THRESHOLD,
  timeoutDuration: Duration.Input = DEFAULT_TIMEOUT,
): Effect.Effect<ReadonlyArray<ScrapingResult>, never, HttpClient.HttpClient> {
  if (!apiKey || results.length === 0) {
    return Effect.succeed(results);
  }

  const successEntries: Array<{
    readonly index: number;
    readonly data: PageMetadata;
  }> = [];

  results.forEach((item, index) => {
    if (item._tag === "Success") {
      successEntries.push({ index, data: item.data });
    }
  });

  if (successEntries.length === 0) {
    return Effect.succeed(results);
  }

  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const previews: Record<
      string,
      {
        readonly url: string;
        readonly title?: string;
        readonly description?: string;
        readonly standard_truncated?: string;
      }
    > = {};
    const questions: Record<string, SystemOneNoulQuestion> = {};
    const sufficiencyAskedKeys = new Set<string>();

    for (const entry of successEntries) {
      const key = `preview_${entry.index}`;
      const description = entry.data.description;
      const isLongDescription =
        description !== undefined &&
        stringWidth(description) > DEFAULT_DESCRIPTION_MAX_WIDTH;
      const standardTruncated = description
        ? truncate(description, DEFAULT_DESCRIPTION_MAX_WIDTH)
        : undefined;

      previews[key] = {
        url: entry.data.url,
        title: entry.data.title,
        description,
        standard_truncated: standardTruncated,
      };
      questions[key] = {
        type: "noul",
        instructions: NOUL_INSTRUCTIONS,
        criteria: NOUL_CRITERIA,
      };

      if (isLongDescription) {
        sufficiencyAskedKeys.add(key);
        questions[`${key}_standard_is_sufficient`] = {
          type: "noul",
          instructions: `Does \`previews.${key}.standard_truncated\` convey the substantive new facts not in \`user_message\`?`,
          criteria: NOUL_SUFFICIENT_CRITERIA,
        };
      }
    }
    const payload: SystemOneRequest = {
      model: DEFAULT_JEV_MODEL,
      state: {
        user_message: rawMessage,
        previews,
      },
      questions,
    };

    const request = yield* HttpClientRequest.post(
      OPENROUTER_SYSTEMONE_URL,
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(apiKey)),
      HttpClientRequest.bodyJson(payload),
    );

    const responseData = yield* Effect.gen(function* () {
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        const webRes = HttpClientResponse.toWeb(response);
        if (webRes._tag === "Some") {
          void webRes.value.body?.cancel().catch(() => {});
        }
        return yield* new JevFilterError({
          cause: `HTTP status ${response.status}`,
        });
      }

      const responseBody = yield* response.json;
      if (
        !responseBody ||
        typeof responseBody !== "object" ||
        !("answers" in responseBody) ||
        typeof (responseBody as Record<string, unknown>).answers !== "object" ||
        (responseBody as Record<string, unknown>).answers === null
      ) {
        return yield* new JevFilterError({
          cause: "Missing or invalid 'answers' envelope in System One response",
        });
      }

      return responseBody as SystemOneResponse;
    }).pipe(
      Effect.timeout(timeoutDuration),
      Effect.mapError((cause) =>
        cause instanceof JevFilterError ? cause : new JevFilterError({ cause }),
      ),
    );

    const answers = responseData.answers ?? {};

    const updated: ScrapingResult[] = [];
    for (let index = 0; index < results.length; index++) {
      const item = results[index]!;
      if (item._tag !== "Success") {
        updated.push(item);
        continue;
      }
      const key = `preview_${index}`;
      const primaryAnswer =
        answers[`${key}_has_substantive_info`] ?? answers[key];
      const score =
        typeof primaryAnswer?.noul === "number" ? primaryAnswer.noul : undefined;
      const passed = score !== undefined && score >= threshold;

      if (passed) {
        let expanded = false;
        if (sufficiencyAskedKeys.has(key)) {
          const sufficiencyAnswer = answers[`${key}_standard_is_sufficient`];
          const sufficiencyScore =
            typeof sufficiencyAnswer?.noul === "number"
              ? sufficiencyAnswer.noul
              : undefined;
          if (sufficiencyScore !== undefined && sufficiencyScore < threshold) {
            expanded = true;
          }
        }
        updated.push({
          ...item,
          expanded,
        });
      } else {
        const scoreText = score !== undefined ? String(score) : "unknown";
        yield* Effect.logInfo(
          `Filtered link preview for ${item.data.url} (score: ${scoreText})`,
        );
        updated.push({
          _tag: "Filtered",
          url: item.data.url,
        });
      }
    }

    return updated;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Jev decision filter failed, falling back to original preview: ${String(error)}`,
      ).pipe(Effect.as(results)),
    ),
  );
}
