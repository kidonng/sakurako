/* oxlint-disable effecttsgo/unstable-api-usage */
import { type Duration, Effect, Predicate, Redacted, Schema } from "effect";
import stringWidth from "string-width";
import { HttpClientRequest } from "effect/http";
import { fetchJson } from "../../utils/HttpClient.ts";
import { DEFAULT_DECISION_MODEL } from "../../Config.ts";
import {
  DEFAULT_DESCRIPTION_MAX_WIDTH,
  isScrapingResult,
  ScrapingFiltered,
  type ScrapingResult,
} from "./LinkPreview.ts";
import { truncate } from "../../utils/TextWidth.ts";

export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
export { DEFAULT_DECISION_MODEL } from "../../Config.ts";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_TIMEOUT: Duration.Input = "10 seconds";

interface DecisionsNoulCriteria {
  readonly true: string;
  readonly false: string;
}

interface DecisionsNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: DecisionsNoulCriteria;
}

interface DecisionsRequest {
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
  readonly questions: Record<string, DecisionsNoulQuestion>;
}

const DecisionsAnswerSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  noul: Schema.optional(Schema.Finite),
});
const DecisionsResponseSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  answers: Schema.optional(Schema.Record(Schema.String, DecisionsAnswerSchema)),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Finite),
      output_tokens: Schema.optional(Schema.Finite),
      cost: Schema.optional(Schema.Finite),
    }),
  ),
});

class DecisionFilterError extends Schema.TaggedError<
  DecisionFilterError,
  {
    readonly brand: unique symbol;
  }
>()("DecisionFilterError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `DecisionFilterError: ${String(this.cause)}`;
  }
}

const NOUL_INSTRUCTIONS =
  "Does the preview for this link provide substantive, valuable, and non-redundant information beyond what is already conveyed in the user message?";

const NOUL_CRITERIA: DecisionsNoulCriteria = {
  true: "The preview provides meaningful context, new facts, or substantial details not already present in the user message, and is not promotional boilerplate, generic site greetings, or channel ads.",
  false:
    "The preview merely repeats information already stated in the user message, or consists of generic site slogans, channel/group promo links, submission bots, or empty boilerplate.",
};

const NOUL_SUFFICIENT_CRITERIA: DecisionsNoulCriteria = {
  true: "The standard truncated excerpt already conveys meaningful new facts not present in user_message.",
  false:
    "The standard truncated excerpt merely repeats what was in user_message, while any new facts only exist further down in description or are absent entirely.",
};

export const filterPreviewResults = Effect.fn(
  "DecisionFilter.filterPreviewResults",
)(function* (
  rawMessage: string,
  results: ReadonlyArray<ScrapingResult>,
  apiKey?: Redacted.Redacted<string>,
  model: string = DEFAULT_DECISION_MODEL,
  threshold: number = DEFAULT_THRESHOLD,
  timeoutDuration: Duration.Input = DEFAULT_TIMEOUT,
) {
  if (!apiKey || results.length === 0) {
    return results;
  }

  const isSuccess = isScrapingResult("Success");
  const successEntries = results.flatMap((item, index) =>
    isSuccess(item) ? [{ index, data: item.data }] : [],
  );

  if (successEntries.length === 0) {
    return results;
  }

  const filterEffect = Effect.gen(function* () {
    const previews: Record<
      string,
      {
        readonly url: string;
        readonly title?: string;
        readonly description?: string;
        readonly standard_truncated?: string;
      }
    > = {};
    const questions: Record<string, DecisionsNoulQuestion> = {};
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
    const payload: DecisionsRequest = {
      model,
      state: {
        user_message: rawMessage,
        previews,
      },
      questions,
    };

    const request = yield* HttpClientRequest.post(
      OPENROUTER_DECISIONS_URL,
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(apiKey)),
      HttpClientRequest.bodyJson(payload),
    );

    const responseData = yield* fetchJson(request, DecisionsResponseSchema, {
      timeoutDuration,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DecisionFilterError({
            cause: cause.detail ?? cause.message,
          }),
      ),
    );

    if (!responseData.answers) {
      return yield* new DecisionFilterError({
        cause: "Missing or invalid 'answers' envelope in Decisions response",
      });
    }

    const answers = responseData.answers ?? {};

    const updated: ScrapingResult[] = [];
    for (let index = 0; index < results.length; index++) {
      const item = results[index]!;
      if (!isSuccess(item)) {
        updated.push(item);
        continue;
      }
      const key = `preview_${index}`;
      const primaryAnswer =
        answers[`${key}_has_substantive_info`] ?? answers[key];
      const score = Predicate.isNumber(primaryAnswer?.noul)
        ? primaryAnswer.noul
        : undefined;
      const passed = score !== undefined && score >= threshold;
      if (passed) {
        let expanded = false;
        if (sufficiencyAskedKeys.has(key)) {
          const sufficiencyAnswer = answers[`${key}_standard_is_sufficient`];
          const sufficiencyScore = Predicate.isNumber(sufficiencyAnswer?.noul)
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
        updated.push(ScrapingFiltered({ url: item.data.url }));
      }
    }

    return updated;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Decision filter failed, falling back to original preview: ${String(error)}`,
      ).pipe(Effect.as(results)),
    ),
  );

  return yield* filterEffect;
});
