/** @jsxRuntime automatic */
/** @jsxImportSource satori/jsx */
/* oxlint-disable effecttsgo/unstable-api-usage */
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import satori from "satori";
import sharp from "sharp";
import type { LeaderboardResult } from "./StatsRepository.ts";

export const FONT_PATH = "assets/fonts/MiSans-Normal.ttf";

export interface RenderLeaderboardOptions {
  readonly groupName?: string;
  readonly timeLabel: string;
  readonly data: LeaderboardResult;
}

export class RenderError extends Schema.TaggedError<
  RenderError,
  {
    readonly brand: unique symbol;
  }
>()("RenderError", {
  message: Schema.String,
}) {}

const GRID_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "40px 1fr 80px 65px 65px 65px",
  columnGap: 8,
  alignItems: "center",
} as const;

const NUMERIC_COL_STYLE = {
  textAlign: "right",
  fontFeatureSettings: '"tnum" 1',
} as const;

export class StatsRenderer extends Context.Service<
  StatsRenderer,
  {
    readonly renderLeaderboard: (
      options: RenderLeaderboardOptions,
    ) => Effect.Effect<Buffer, RenderError>;
  }
>()("sakurako/StatsRenderer") {
  static readonly layer = Layer.effect(
    StatsRenderer,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const fontBytes = yield* fs.readFile(FONT_PATH).pipe(
        Effect.mapError(
          (err) =>
            new Error(
              `Failed to read font file at ${FONT_PATH}: ${String(err)}`,
            ),
        ),
        Effect.orDie,
      );
      const fontData = Buffer.from(fontBytes);

      const satoriFonts: NonNullable<Parameters<typeof satori>[1]>["fonts"] = [
        {
          name: "MiSans",
          data: fontData,
          weight: 400,
          style: "normal",
        },
      ];
      const renderLeaderboard = Effect.fnUntraced(function* (
        options: RenderLeaderboardOptions,
      ) {
        const { groupName, timeLabel, data } = options;
        const { groupTotal, rows } = data;

        const jsx = (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: 620,
              boxSizing: "border-box",
              backgroundColor: "#18191c",
              padding: 24,
              borderRadius: 12,
              color: "#ffffff",
              fontFamily: "MiSans",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-end",
                borderBottom: "1px solid #30363d",
                paddingBottom: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    color: "#f0f6fc",
                  }}
                >
                  群消息统计排行榜
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "#8b949e",
                    marginTop: 4,
                  }}
                >
                  {groupName ? `${groupName} · ${timeLabel}` : timeLabel}
                </div>
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "#8b949e",
                  ...NUMERIC_COL_STYLE,
                }}
              >
                群总发言 {groupTotal.toLocaleString()}
              </div>
            </div>

            {/* Table Header */}
            <div
              style={{
                ...GRID_ROW_STYLE,
                padding: "6px 12px",
                borderBottom: "1px solid #30363d",
                fontSize: 13,
                color: "#8b949e",
              }}
            >
              <div>排名</div>
              <div>群成员</div>
              <div style={NUMERIC_COL_STYLE}>总计</div>
              <div style={{ ...NUMERIC_COL_STYLE, color: "#79c0ff" }}>媒体</div>
              <div style={{ ...NUMERIC_COL_STYLE, color: "#d2a8ff" }}>链接</div>
              <div style={{ ...NUMERIC_COL_STYLE, color: "#ffa657" }}>互动</div>
            </div>

            {/* Table Body */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {rows.map((row, index) => {
                const rank = index + 1;
                let rankColor = "#8b949e";
                let rowBg = "transparent";

                if (rank === 1) {
                  rankColor = "#f1e05a";
                  rowBg = "rgba(241, 224, 90, 0.12)";
                } else if (rank === 2) {
                  rankColor = "#c0c0c0";
                  rowBg = "rgba(192, 192, 192, 0.08)";
                } else if (rank === 3) {
                  rankColor = "#cd7f32";
                  rowBg = "rgba(205, 127, 50, 0.08)";
                }

                return (
                  <div
                    style={{
                      ...GRID_ROW_STYLE,
                      padding: "8px 12px",
                      borderBottom: "1px solid #21262d",
                      backgroundColor: rowBg,
                      fontSize: 14,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        color: rankColor,
                        ...NUMERIC_COL_STYLE,
                        textAlign: "left",
                      }}
                    >
                      {rank}
                    </div>
                    <div
                      style={{
                        fontWeight: 600,
                        color: "#f0f6fc",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        paddingRight: 4,
                      }}
                    >
                      {row.nickname || String(row.userId)}
                    </div>
                    <div
                      style={{
                        fontWeight: 700,
                        color: "#f0f6fc",
                        ...NUMERIC_COL_STYLE,
                      }}
                    >
                      {row.totalCount.toLocaleString()}
                    </div>
                    <div
                      style={{
                        color: "#79c0ff",
                        ...NUMERIC_COL_STYLE,
                      }}
                    >
                      {row.mediaCount.toLocaleString()}
                    </div>
                    <div
                      style={{
                        color: "#d2a8ff",
                        ...NUMERIC_COL_STYLE,
                      }}
                    >
                      {row.linkCount.toLocaleString()}
                    </div>
                    <div
                      style={{
                        color: "#ffa657",
                        ...NUMERIC_COL_STYLE,
                      }}
                    >
                      {row.interactionCount.toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 16,
                fontSize: 12,
                color: "#6e7681",
              }}
            >
              <div>Sakurako Bot · 消息统计</div>
              <div>展示前 {rows.length} 名</div>
            </div>
          </div>
        );

        const svg = yield* Effect.tryPromise({
          try: () =>
            satori(jsx, {
              width: 620,
              pointScaleFactor: 2,
              fonts: satoriFonts,
              onStyleError: (e) => {
                // oxlint-disable-next-line effecttsgo/run-effect-inside-effect
                Effect.runSync(
                  Effect.logWarning(`Satori style error: ${e.message}`),
                );
              },
            }),
          catch: (e) => new RenderError({ message: String(e) }),
        });

        const png = yield* Effect.tryPromise({
          try: () =>
            sharp(Buffer.from(svg), { density: 144 })
              .png({ compressionLevel: 6, effort: 4 })
              .toBuffer(),
          catch: (e) => new RenderError({ message: String(e) }),
        });

        return png;
      });

      return StatsRenderer.of({
        renderLeaderboard,
      });
    }),
  ).pipe(Layer.provide(BunFileSystem.layer));
}
