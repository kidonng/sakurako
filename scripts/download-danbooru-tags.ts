/* oxlint-disable effecttsgo/unstable-api-usage */
import { Database } from "bun:sqlite";
import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";

const TAGS_DB_URL =
  "https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite";

class TagDownloadError extends Schema.TaggedError<
  TagDownloadError,
  {
    readonly brand: unique symbol;
  }
>()("TagDownloadError", {
  message: Schema.String,
}) {}

export const downloadTagsProgram = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const outputFile = path.join(
    import.meta.dir,
    "../assets/danbooru-tags.sqlite",
  );
  const outputDir = path.dirname(outputFile);

  yield* fs.makeDirectory(outputDir, { recursive: true });

  const exists = yield* fs.exists(outputFile);
  if (!exists) {
    yield* Effect.logInfo(
      `Downloading Danbooru tags database from ${TAGS_DB_URL}...`,
    );

    const response = yield* Effect.tryPromise(() => fetch(TAGS_DB_URL));
    if (!response.ok) {
      return yield* new TagDownloadError({
        message: `Failed to download tags database: ${response.status} ${response.statusText}`,
      });
    }

    const arrayBuffer = yield* Effect.tryPromise(() => response.arrayBuffer());
    yield* fs.writeFile(outputFile, new Uint8Array(arrayBuffer));
    yield* Effect.logInfo(
      `Saved Danbooru tags database to ${outputFile} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`,
    );
  } else {
    yield* Effect.logInfo(`Tags database already exists at ${outputFile}`);
  }

  yield* Effect.logInfo("Ensuring database indexes...");
  yield* Effect.sync(() => {
    const db = new Database(outputFile);
    try {
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);",
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_tags_cn_name ON tags(cn_name);");
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);",
      );
    } finally {
      db.close();
    }
  });
  yield* Effect.logInfo("Danbooru tags database ready.");
});

const MainLive = downloadTagsProgram.pipe(
  Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
);

if (import.meta.main) {
  BunRuntime.runMain(MainLive);
}
