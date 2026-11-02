/* oxlint-disable effecttsgo/unstable-api-usage */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import satori from "satori";
import sharp from "sharp";
import type { LeaderboardResult } from "./StatsRepository.ts";

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
      const path = yield* Path;
      const fontPath = path.join(
        import.meta.dir,
        "../../../assets/fonts/MiSans-Normal.ttf",
      );
      const fontBytes = yield* fs
        .readFile(fontPath)
        .pipe(
          Effect.catch((err) =>
            Effect.die(
              new Error(
                `Failed to read font file at ${fontPath}: ${String(err)}`,
              ),
            ),
          ),
        );
      const fontData = Buffer.from(fontBytes);

      const renderLeaderboard = Effect.fnUntraced(function* (
        options: RenderLeaderboardOptions,
      ) {
        const { groupName, timeLabel, data } = options;
        const { groupTotal, rows } = data;

        const tableRows = rows.map((row, index) => {
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

          return {
            type: "div",
            props: {
              style: {
                display: "flex",
                alignItems: "center",
                padding: "8px 12px",
                borderBottom: "1px solid #21262d",
                backgroundColor: rowBg,
                fontSize: 14,
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      width: 40,
                      fontWeight: 700,
                      color: rankColor,
                    },
                    children: String(rank),
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      flex: 1,
                      fontWeight: 600,
                      color: "#f0f6fc",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                    children: row.nickname || String(row.userId),
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      width: 80,
                      textAlign: "right",
                      fontWeight: 700,
                      color: "#f0f6fc",
                    },
                    children: row.totalCount.toLocaleString(),
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      width: 65,
                      textAlign: "right",
                      color: "#79c0ff",
                    },
                    children: row.mediaCount.toLocaleString(),
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      width: 65,
                      textAlign: "right",
                      color: "#d2a8ff",
                    },
                    children: row.linkCount.toLocaleString(),
                  },
                },
                {
                  type: "div",
                  props: {
                    style: {
                      width: 65,
                      textAlign: "right",
                      color: "#ffa657",
                    },
                    children: row.interactionCount.toLocaleString(),
                  },
                },
              ],
            },
          };
        });

        const vdom = {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              width: 620,
              boxSizing: "border-box",
              backgroundColor: "#18191c",
              padding: 24,
              borderRadius: 12,
              color: "#ffffff",
              fontFamily: "MiSans",
            },
            children: [
              // Header
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-end",
                    borderBottom: "1px solid #30363d",
                    paddingBottom: 12,
                    marginBottom: 12,
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: { display: "flex", flexDirection: "column" },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: 20,
                                fontWeight: 700,
                                color: "#f0f6fc",
                              },
                              children: "群消息统计排行榜",
                            },
                          },
                          {
                            type: "div",
                            props: {
                              style: {
                                fontSize: 13,
                                color: "#8b949e",
                                marginTop: 4,
                              },
                              children: groupName
                                ? `${groupName} · ${timeLabel}`
                                : timeLabel,
                            },
                          },
                        ],
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: 14,
                          color: "#8b949e",
                        },
                        children: `群总发言 ${groupTotal.toLocaleString()}`,
                      },
                    },
                  ],
                },
              },
              // Table Header
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    padding: "6px 12px",
                    borderBottom: "1px solid #30363d",
                    fontSize: 13,
                    color: "#8b949e",
                  },
                  children: [
                    {
                      type: "div",
                      props: { style: { width: 40 }, children: "排名" },
                    },
                    {
                      type: "div",
                      props: { style: { flex: 1 }, children: "群成员" },
                    },
                    {
                      type: "div",
                      props: {
                        style: { width: 80, textAlign: "right" },
                        children: "总计",
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          width: 65,
                          textAlign: "right",
                          color: "#79c0ff",
                        },
                        children: "媒体",
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          width: 65,
                          textAlign: "right",
                          color: "#d2a8ff",
                        },
                        children: "链接",
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          width: 65,
                          textAlign: "right",
                          color: "#ffa657",
                        },
                        children: "互动",
                      },
                    },
                  ],
                },
              },
              // Table Body
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column" },
                  children: tableRows,
                },
              },
              // Footer
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 16,
                    fontSize: 12,
                    color: "#6e7681",
                  },
                  children: [
                    {
                      type: "div",
                      props: { children: "Sakurako Bot · 消息统计" },
                    },
                    {
                      type: "div",
                      props: {
                        children: `展示前 ${rows.length} 名`,
                      },
                    },
                  ],
                },
              },
            ],
          },
        };

        const svg = yield* Effect.tryPromise({
          try: () =>
            satori(vdom, {
              width: 620,
              fonts: [
                {
                  name: "MiSans",
                  data: fontData,
                  weight: 400,
                  style: "normal",
                },
              ],
            }),
          catch: (e) => new RenderError({ message: String(e) }),
        });

        const png = yield* Effect.tryPromise({
          try: () => sharp(Buffer.from(svg), { density: 144 }).png().toBuffer(),
          catch: (e) => new RenderError({ message: String(e) }),
        });

        return png;
      });

      return StatsRenderer.of({
        renderLeaderboard,
      });
    }),
  ).pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunPath.layer));
}
