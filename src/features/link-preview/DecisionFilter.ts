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
import { isGenericIconUrl, isInvalidTitle } from "./DecisionHeuristics.ts";

export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_TITLE_THRESHOLD = 0.3;
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

const makeTitleQuestion = (key: string): DecisionsNoulQuestion => ({
  type: "noul",
  instructions: `Evaluate whether \`previews.${key}.title\` is a legitimate, meaningful content title rather than an unhydrated shell, loading placeholder, or generic error message.`,
  criteria: {
    true: "The title represents real page content, article title, media title, or specific topic, even if short or similar to the URL.",
    false:
      'The title is a generic site placeholder (e.g. "React App", "Home"), an unhydrated loading state, or an error shell.',
  },
});

const makeDescriptionQuestion = (
  key: string,
  hasImages: boolean = false,
): DecisionsNoulQuestion => ({
  type: "noul",
  instructions: hasImages
    ? `Evaluate whether \`previews.${key}.description\` offers substantive incremental knowledge compared to the user's message and attached images in \`state\`.`
    : `Evaluate whether \`previews.${key}.description\` offers substantive incremental knowledge compared to \`user_message\`.`,
  criteria: {
    true: hasImages
      ? "The description contains distinct, substantive details, technical explanations, or factual reporting absent from the user's message and attached images."
      : "The description contains distinct, substantive details, technical explanations, or factual reporting absent from `user_message`.",
    false: hasImages
      ? "The description is redundant with the user's message or attached images, vacuous, generic site shell text (e.g. login wall, cookie banner), or promotional noise."
      : "The description is redundant with `user_message`, vacuous, generic site shell text (e.g. login wall, cookie banner), or promotional noise.",
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
    const titleAskedKeys = new Set<string>();

    const hasImages = Boolean(userImages && userImages.length > 0);
    for (const entry of successEntries) {
      const key = `preview_${entry.index}`;
      const rawTitle = entry.data.title;
      const rawDescription = entry.data.description;

      const hasRawTitle = rawTitle !== undefined && rawTitle.trim().length > 0;
      const isTitleInvalid = hasRawTitle && isInvalidTitle(rawTitle);

      const isLongDescription =
        rawDescription !== undefined &&
        stringWidth(rawDescription) > DEFAULT_DESCRIPTION_MAX_WIDTH;
      const standardTruncated = rawDescription
        ? truncate(rawDescription, DEFAULT_DESCRIPTION_MAX_WIDTH)
        : undefined;

      previews[key] = {
        url: entry.data.url,
        title: hasRawTitle ? rawTitle : undefined,
        description: rawDescription,
        standard_truncated: standardTruncated,
      };

      if (hasRawTitle && !isTitleInvalid) {
        titleAskedKeys.add(key);
        questions[`${key}_title_is_meaningful`] = makeTitleQuestion(key);
      }

      if (rawDescription !== undefined && rawDescription.trim().length > 0) {
        questions[`${key}_description_has_substantive_info`] =
          makeDescriptionQuestion(key, hasImages);
        if (isLongDescription) {
          sufficiencyAskedKeys.add(key);
          questions[`${key}_standard_is_sufficient`] =
            makeSufficiencyQuestion(key);
        }
      }
    }

    let answers: Record<string, typeof DecisionsAnswerSchema.Type> = {};

    if (Object.keys(questions).length > 0) {
      const stateContext: DecisionsStateContext = {
        user_message: rawMessage,
        previews,
      };
      const state: DecisionsState =
        userImages && userImages.length > 0
          ? [
              stateContext,
              ...userImages.map(
                (url): DecisionsImageUrlPart => ({
                  type: "image_url",
                  image_url: { url },
                }),
              ),
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
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.bodyJson(payload),
      );

      const responseData = yield* fetchJson(
        request,
        DecisionsResponseSchema,
        {
          timeoutDuration: DEFAULT_TIMEOUT,
        },
      ).pipe(
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

      answers = responseData.answers ?? {};
    }

    const updated: ScrapingResult[] = [];
    for (let index = 0; index < results.length; index++) {
      const item = results[index]!;
      if (!isSuccess(item)) {
        updated.push(item);
        continue;
      }
      const key = `preview_${index}`;
      const rawTitle = item.data.title;
      const rawDescription = item.data.description;
      const rawImage = item.data.image;
      const rawFallbackImage = item.data.fallbackImage;

      // Local image heuristic
      const candidateImage =
        rawImage && !isGenericIconUrl(rawImage) ? rawImage : undefined;
      const candidateFallbackImage =
        rawFallbackImage && !isGenericIconUrl(rawFallbackImage)
          ? rawFallbackImage
          : undefined;

      // Title evaluation
      const hasRawTitle = rawTitle !== undefined && rawTitle.trim().length > 0;
      let titleValid = true;
      let titleScore: number | undefined = undefined;
      if (hasRawTitle) {
        if (isInvalidTitle(rawTitle)) {
          titleValid = false;
        } else if (titleAskedKeys.has(key)) {
          const titleAnswer =
            answers[`${key}_title_is_meaningful`] ?? answers[key];
          titleScore = Predicate.isNumber(titleAnswer?.noul)
            ? titleAnswer.noul
            : undefined;
          if (
            titleScore === undefined ||
            titleScore < DEFAULT_TITLE_THRESHOLD
          ) {
            titleValid = false;
          }
        }
      }

      // Title cascade: if title was present and invalid, drop entire preview
      if (hasRawTitle && !titleValid) {
        const scoreText =
          titleScore !== undefined ? String(titleScore) : "heuristic/unknown";
        yield* Effect.logInfo(
          `Filtered link preview for ${item.data.url} (invalid title, score: ${scoreText})`,
        );
        updated.push(ScrapingFiltered({ url: item.data.url }));
        continue;
      }

      // Description evaluation
      let survivingDescription: string | undefined = undefined;
      let expanded = false;
      if (rawDescription !== undefined && rawDescription.trim().length > 0) {
        const descAnswer =
          answers[`${key}_description_has_substantive_info`] ??
          answers[`${key}_has_substantive_info`] ??
          answers[key];
        const descScore = Predicate.isNumber(descAnswer?.noul)
          ? descAnswer.noul
          : undefined;
        const descPassed =
          descScore !== undefined && descScore >= threshold;
        if (descPassed) {
          survivingDescription = rawDescription;
          if (sufficiencyAskedKeys.has(key)) {
            const sufficiencyAnswer = answers[`${key}_standard_is_sufficient`];
            const sufficiencyScore = Predicate.isNumber(
              sufficiencyAnswer?.noul,
            )
              ? sufficiencyAnswer.noul
              : undefined;
            if (
              sufficiencyScore !== undefined &&
              sufficiencyScore < threshold
            ) {
              expanded = true;
            }
          }
        } else {
          const scoreText =
            descScore !== undefined ? String(descScore) : "unknown";
          yield* Effect.logInfo(
            `Stripped link preview description for ${item.data.url} (score: ${scoreText})`,
          );
        }
      }

      const survivingTitle = hasRawTitle && titleValid ? rawTitle : undefined;

      // Anchor invariant: preview must have at least surviving title or image
      if (!survivingTitle && !candidateImage) {
        yield* Effect.logInfo(
          `Filtered link preview for ${item.data.url} (lacks surviving title or image anchor)`,
        );
        updated.push(ScrapingFiltered({ url: item.data.url }));
        continue;
      }

      updated.push({
        ...item,
        data: {
          ...item.data,
          title: survivingTitle,
          description: survivingDescription,
          image: candidateImage,
          fallbackImage: candidateFallbackImage,
        },
        expanded,
      });
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
