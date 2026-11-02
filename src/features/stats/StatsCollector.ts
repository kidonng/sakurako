import { Effect } from "effect";
import type { IncomingMessage, IncomingNotice } from "../../SnowLuma.ts";
import { isGroupMessage, isSelfMessage } from "../../utils/MessageGuard.ts";
import {
  classifyMessage,
  getNoticeOperatorId,
  getShanghaiDateString,
  isGroupPokeNotice,
  isGroupReactionNotice,
} from "./StatsClassifier.ts";
import { StatsRepository } from "./StatsRepository.ts";

export const handleStatsMessage = Effect.fnUntraced(
  function* (item: IncomingMessage) {
    const { event } = item;
    if (isSelfMessage(event)) {
      return;
    }

    if (!isGroupMessage(event)) {
      return;
    }

    const repo = yield* StatsRepository;
    const nickname =
      event.sender?.card || event.sender?.nickname || String(event.user_id);
    const date = getShanghaiDateString();

    yield* repo.upsertProfile(event.group_id, event.user_id, nickname);
    const classification = classifyMessage(event.message, event.raw_message);
    yield* repo.recordMessage(
      event.group_id,
      event.user_id,
      date,
      classification,
    );
  },
  Effect.catch((err) =>
    Effect.logWarning(
      `[StatsCollector] Failed to record message: ${String(err)}`,
    ),
  ),
  Effect.catchDefect((defect) =>
    Effect.logError(
      `[StatsCollector] Defect in record message: ${String(defect)}`,
    ),
  ),
);

export const handleStatsNotice = Effect.fnUntraced(
  function* (item: IncomingNotice) {
    const { event } = item;
    if (isSelfMessage(event)) {
      return;
    }

    const repo = yield* StatsRepository;
    const date = getShanghaiDateString();

    if (isGroupPokeNotice(event)) {
      yield* repo.recordInteraction(event.group_id, event.user_id, date);
    } else if (isGroupReactionNotice(event)) {
      if (event.sub_type === "add") {
        const userId = getNoticeOperatorId(event);
        if (typeof userId === "number") {
          yield* repo.recordInteraction(event.group_id, userId, date);
        }
      }
    }
  },
  Effect.catch((err) =>
    Effect.logWarning(
      `[StatsCollector] Failed to record notice: ${String(err)}`,
    ),
  ),
  Effect.catchDefect((defect) =>
    Effect.logError(
      `[StatsCollector] Defect in record notice: ${String(defect)}`,
    ),
  ),
);
