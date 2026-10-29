/* oxlint-disable effecttsgo/unstable-api-usage */
import { Data, type Duration, Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { PageMetadata, ScrapingResult } from "./LinkPreview.ts";

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
      }
    > = {};
    const questions: Record<string, SystemOneNoulQuestion> = {};

    for (const entry of successEntries) {
      const key = `preview_${entry.index}`;
      previews[key] = {
        url: entry.data.url,
        title: entry.data.title,
        description: entry.data.description,
      };
      questions[key] = {
        type: "noul",
        instructions: NOUL_INSTRUCTIONS,
        criteria: NOUL_CRITERIA,
      };
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

    const updated = results.map((item, index): ScrapingResult => {
      if (item._tag !== "Success") {
        return item;
      }
      const key = `preview_${index}`;
      const answer = answers[key];
      const passed =
        typeof answer?.noul === "number" && answer.noul >= threshold;

      if (passed) {
        return item;
      }

      return {
        _tag: "Filtered",
        url: item.data.url,
      };
    });

    return updated;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Jev decision filter failed, falling back to original preview: ${String(error)}`,
      ).pipe(Effect.as(results)),
    ),
  );
}
