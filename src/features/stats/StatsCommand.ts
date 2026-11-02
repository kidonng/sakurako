import { segments } from "@snowluma/sdk/messages";
import { DateTime, Effect } from "effect";
import type { IncomingMessage } from "../../SnowLuma.ts";
import { isSelfMessage } from "../../utils/MessageGuard.ts";
import { parseCommand } from "../../utils/Command.ts";
import { getDaysAgoShanghaiDateString } from "./StatsClassifier.ts";
import { StatsCooldown } from "./StatsCooldown.ts";
import { StatsRenderer } from "./StatsRenderer.ts";
import { StatsRepository } from "./StatsRepository.ts";

export const handleStatsCommand = Effect.fnUntraced(
  function* (item: IncomingMessage) {
    const { event } = item;
    if (isSelfMessage(event)) {
      return;
    }

    if (
      event.message_type !== "group" ||
      typeof event.group_id !== "number" ||
      typeof event.user_id !== "number"
    ) {
      return;
    }

    const command = parseCommand(event);
    if (!command) {
      return;
    }

    const text = command.text;
    if (text === "/stat" || text === "/stat all") {
      const cooldown = yield* StatsCooldown;
      const allowed = yield* cooldown.checkAndSet(event.group_id);
      if (!allowed) {
        return;
      }

      const isAllTime = text === "/stat all";
      let startDate: string | undefined = undefined;
      let timeLabel = "历史累计";

      if (!isAllTime) {
        const now = yield* DateTime.now;
        startDate = getDaysAgoShanghaiDateString(29, now);
        timeLabel = "最近 30 天";
      }
      const repo = yield* StatsRepository;
      const renderer = yield* StatsRenderer;
      const lb = yield* repo.getLeaderboard(event.group_id, startDate);

      if (lb.groupTotal === 0 || lb.rows.length === 0) {
        yield* Effect.tryPromise(() =>
          item.context.quote("本群暂无统计数据。"),
        );
        return;
      }

      const groupName = (event as Record<string, unknown>).group_name as
        string | undefined;
      const pngBuffer = yield* renderer.renderLeaderboard({
        groupName: groupName || `群 ${event.group_id}`,
        timeLabel,
        data: lb,
      });

      const imageSegment = segments.image(
        `base64://${pngBuffer.toString("base64")}`,
      );
      yield* Effect.tryPromise(() => item.context.quote(imageSegment));
    } else if (text === "/me") {
      const now = yield* DateTime.now;
      const startDate30d = getDaysAgoShanghaiDateString(29, now);

      const repo = yield* StatsRepository;
      const stats = yield* repo.getUserStats(
        event.group_id,
        event.user_id,
        startDate30d,
      );

      const rank30d =
        stats.stats30d.rank !== null ? String(stats.stats30d.rank) : "-";
      const rankAll =
        stats.statsAll.rank !== null ? String(stats.statsAll.rank) : "-";

      const lines = [
        "📊 个人群聊统计 (近 30 天 / 历史累计)",
        `- 消息总计：${stats.stats30d.totalCount.toLocaleString()} / ${stats.statsAll.totalCount.toLocaleString()} 条 (排名第 ${rank30d} / ${rankAll})`,
        `- 媒体消息：${stats.stats30d.mediaCount.toLocaleString()} / ${stats.statsAll.mediaCount.toLocaleString()} 条`,
        `- 包含链接：${stats.stats30d.linkCount.toLocaleString()} / ${stats.statsAll.linkCount.toLocaleString()} 条`,
        `- 互动次数：${stats.stats30d.interactionCount.toLocaleString()} / ${stats.statsAll.interactionCount.toLocaleString()} 次`,
      ];

      yield* Effect.tryPromise(() => item.context.quote(lines.join("\n")));
    }
  },
  Effect.catch((err) =>
    Effect.logError(`[StatsCommand] Failed to execute command: ${String(err)}`),
  ),
  Effect.catchDefect((defect) =>
    Effect.logError(
      `[StatsCommand] Defect in command handler: ${String(defect)}`,
    ),
  ),
);
