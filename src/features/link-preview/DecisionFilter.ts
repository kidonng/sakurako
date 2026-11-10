/* oxlint-disable effecttsgo/unstable-api-usage */
import {
  Effect,
  Predicate,
  type Redacted,
  Schema,
} from "effect";
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
const DEFAULT_THRESHOLD = 0.7;

interface DecisionsNoulCriteria {
  readonly true: string;
  readonly false: string;
}

interface DecisionsNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: DecisionsNoulCriteria;
}

export interface DecisionsImageUrlPart {
  readonly type: "image_url";
  readonly image_url: {
    readonly url: string;
  };
}

interface DecisionsStateContext {
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
}

type DecisionsState =
  | DecisionsStateContext
  | ReadonlyArray<DecisionsStateContext | DecisionsImageUrlPart>;

interface DecisionsRequest {
  readonly model: string;
  readonly state: DecisionsState;
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

const makeNoulQuestion = (
  key: string,
  hasImages: boolean = false,
): DecisionsNoulQuestion => ({
  type: "noul",
  instructions: hasImages
    ? `Evaluate whether \`previews.${key}\` offers substantive incremental knowledge compared to the user's message and attached images in \`state\`.`
    : `Evaluate whether \`previews.${key}\` offers substantive incremental knowledge compared to \`user_message\`.`,
  criteria: {
    true: hasImages
      ? "The preview contains distinct, substantive details, technical explanations, or factual reporting absent from the user's message and attached images."
      : "The preview contains distinct, substantive details, technical explanations, or factual reporting absent from `user_message`.",
    false: hasImages
      ? "The preview is redundant with the user's message or attached images, vacuous, generic site shell text (e.g. login wall, cookie banner), or promotional noise."
      : "The preview is redundant with `user_message`, vacuous, generic site shell text (e.g. login wall, cookie banner), or promotional noise.",
  },
});

const makeSufficiencyQuestion = (key: string): DecisionsNoulQuestion => ({
  type: "noul",
  instructions: `Is \`previews.${key}.standard_truncated\` sufficient on its own to convey the essential incremental information?`,
  criteria: {
    true: "The essential new facts are already clear within `standard_truncated`, so expanding is unnecessary.",
    false:
      "Crucial new facts or core conclusions only appear in the tail of `description` and are lost in `standard_truncated`.",
  },
});

export const filterPreviewResults = Effect.fn(
  "DecisionFilter.filterPreviewResults",
)(function* (
  rawMessage: string,
  results: ReadonlyArray<ScrapingResult>,
  apiKey?: Redacted.Redacted<string>,
  model: string = DEFAULT_DECISION_MODEL,
  threshold: number = DEFAULT_THRESHOLD,
  userImages?: ReadonlyArray<string>,
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

    const hasImages = Boolean(userImages && userImages.length > 0);
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
      questions[key] = makeNoulQuestion(key, hasImages);

      if (isLongDescription) {
        sufficiencyAskedKeys.add(key);
        questions[`${key}_standard_is_sufficient`] =
          makeSufficiencyQuestion(key);
      }
    }
    const stateContext: DecisionsStateContext = {
      user_message: rawMessage,
      previews,
    };
    const state: DecisionsState =
      userImages && userImages.length > 0
        ? [
            stateContext,
            ...userImages.map((url): DecisionsImageUrlPart => ({
              type: "image_url",
              image_url: { url },
            })),
          ]
        : stateContext;

    const payload: DecisionsRequest = {
      model,
      state,
      questions,
    };

    const request = yield* HttpClientRequest.post(
      OPENROUTER_DECISIONS_URL,
    ).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJson(payload),
    );

    const responseData = yield* fetchJson(request, DecisionsResponseSchema).pipe(
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
