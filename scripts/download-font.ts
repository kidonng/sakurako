/* oxlint-disable effecttsgo/unstable-api-usage */
import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";

const FONT_URL = "https://hyperos.mi.com/font-download/MiSans.zip";
const TARGET_ENTRY = "MiSans/ttf/MiSans-Normal.ttf";
class FontDownloadError extends Schema.TaggedError<
  FontDownloadError,
  {
    readonly brand: unique symbol;
  }
>()("FontDownloadError", {
  message: Schema.String,
}) {}


const mainProgram = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const outputFile = path.join(
    import.meta.dir,
    "../assets/fonts/MiSans-Normal.ttf",
  );
  const outputDir = path.dirname(outputFile);

  const exists = yield* fs.exists(outputFile);
  if (exists) {
    yield* Effect.logInfo(`Font already exists at ${outputFile}`);
    return;
  }

  yield* fs.makeDirectory(outputDir, { recursive: true });
  yield* Effect.logInfo(`Downloading MiSans font from ${FONT_URL}...`);

  const response = yield* Effect.tryPromise(() => fetch(FONT_URL));
  if (!response.ok) {
    return yield* new FontDownloadError({
      message: `Failed to download font: ${response.status} ${response.statusText}`,
    });
  }

  const arrayBuffer = yield* Effect.tryPromise(() => response.arrayBuffer());
  const tempZipPath = path.join(outputDir, "MiSans.temp.zip");
  yield* fs.writeFile(tempZipPath, new Uint8Array(arrayBuffer));

  yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        const proc = Bun.spawn(["unzip", "-p", tempZipPath, TARGET_ENTRY]);
        const fontBuffer = yield* Effect.tryPromise(() =>
          new Response(proc.stdout).arrayBuffer(),
        );
        const exitCode = yield* Effect.tryPromise(() => proc.exited);

        if (exitCode !== 0 || fontBuffer.byteLength === 0) {
          return yield* new FontDownloadError({
            message: `Failed to extract ${TARGET_ENTRY} from zip archive`,
          });
        }
        yield* fs.writeFile(outputFile, new Uint8Array(fontBuffer));
        yield* Effect.logInfo(
          `Saved font to ${outputFile} (${(fontBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`,
        );
      }),
    () => fs.remove(tempZipPath).pipe(Effect.ignore),
  );
});

const MainLive = mainProgram.pipe(
  Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
);

if (import.meta.main) {
  BunRuntime.runMain(MainLive);
}
