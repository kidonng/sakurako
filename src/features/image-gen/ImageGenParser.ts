export const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
] as const;

export type SupportedAspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

const SUPPORTED_ASPECT_RATIO_SET: ReadonlySet<string> = new Set(
  SUPPORTED_ASPECT_RATIOS,
);

export interface ParsedImageGenInput {
  readonly aspectRatio?: SupportedAspectRatio;
  readonly prompt: string;
}

export function parseImageGenInput(
  text: string,
): ParsedImageGenInput | undefined {
  const trimmed = text.trim();
  if (trimmed !== "/gen" && !/^\/gen\s/.test(trimmed)) {
    return undefined;
  }

  const rest = trimmed.slice(4).trim();
  if (rest.length === 0) {
    return { prompt: "" };
  }

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!match) {
    return { prompt: rest };
  }

  const normalizedFirstToken = match[1]!.replaceAll("：", ":");
  if (SUPPORTED_ASPECT_RATIO_SET.has(normalizedFirstToken)) {
    return {
      aspectRatio: normalizedFirstToken as SupportedAspectRatio,
      prompt: (match[2] ?? "").trim(),
    };
  }

  return { prompt: rest };
}
