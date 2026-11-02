import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FONT_URL = "https://hyperos.mi.com/font-download/MiSans.zip";
const OUTPUT_FILE = join(import.meta.dir, "../assets/fonts/MiSans-Normal.ttf");
const TARGET_ENTRY = "MiSans/ttf/MiSans-Normal.ttf";

async function main(): Promise<void> {
  if (existsSync(OUTPUT_FILE)) {
    console.log(`Font already exists at ${OUTPUT_FILE}`);
    return;
  }

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  console.log(`Downloading MiSans font from ${FONT_URL}...`);

  const response = await fetch(FONT_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download font: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const tempZipPath = join(dirname(OUTPUT_FILE), "MiSans.temp.zip");
  writeFileSync(tempZipPath, Buffer.from(arrayBuffer));

  try {
    const proc = Bun.spawn([
      "unzip",
      "-p",
      tempZipPath,
      TARGET_ENTRY,
    ]);
    const fontBuffer = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || fontBuffer.byteLength === 0) {
      throw new Error(`Failed to extract ${TARGET_ENTRY} from zip archive`);
    }

    writeFileSync(OUTPUT_FILE, Buffer.from(fontBuffer));
    console.log(
      `Saved font to ${OUTPUT_FILE} (${(fontBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`,
    );
  } finally {
    try {
      unlinkSync(tempZipPath);
    } catch {
      // Ignore cleanup error
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
