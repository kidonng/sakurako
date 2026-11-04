export interface DanbooruPostTitleMeta {
  readonly id: number;
  readonly tag_string_character: string;
  readonly tag_string_copyright: string;
  readonly tag_string_artist: string;
}

function splitRawTags(raw: string): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw.trim().split(/\s+/).filter(Boolean);
}

function parseCharacterSeries(name: string): { base: string; series?: string } {
  const match = name.match(/^(.*?)[（(]([^）)]+)[）)]$/);
  if (match && match[1] && match[2]) {
    return { base: match[1].trim(), series: match[2].trim() };
  }
  return { base: name };
}

export function formatDanbooruTitle(
  post: DanbooruPostTitleMeta,
  translations?: ReadonlyMap<string, string>,
): string {
  const charTags = splitRawTags(post.tag_string_character);
  const displayedCharTags = charTags.slice(0, 5);

  const parsedChars = displayedCharTags.map((tag) => {
    const translated = translations?.get(tag) ?? tag.replaceAll("_", " ");
    const { base, series } = parseCharacterSeries(translated);
    return { raw: translated, base, series };
  });

  const shouldStripSeries =
    parsedChars.length === 1 ||
    (parsedChars.length > 1 &&
      parsedChars.every(
        (c) => c.series !== undefined && c.series === parsedChars[0]?.series,
      ));

  const charNames = parsedChars.map((c) =>
    shouldStripSeries ? c.base : c.raw,
  );
  let charStr = charNames.join("、");
  if (charTags.length > 5) {
    charStr = charStr
      ? `${charStr} 等 ${charTags.length - 5} 位`
      : `等 ${charTags.length - 5} 位`;
  }

  const copyTags = splitRawTags(post.tag_string_copyright);
  const firstCopyTag = copyTags[0];
  let firstCopyName: string | undefined;
  if (firstCopyTag) {
    firstCopyName =
      translations?.get(firstCopyTag) ?? firstCopyTag.replaceAll("_", " ");
  } else if (shouldStripSeries && parsedChars[0]?.series) {
    firstCopyName = parsedChars[0].series;
  }

  let copyStr = "";
  if (firstCopyName) {
    copyStr = firstCopyName;
    if (copyTags.length > 1) {
      copyStr = `${copyStr} 等 ${copyTags.length - 1} 部`;
    }
    if (charStr) {
      copyStr = `(${copyStr})`;
    }
  }

  const artistTags = splitRawTags(post.tag_string_artist);
  const artistNames = artistTags.map(
    (tag) => translations?.get(tag) ?? tag,
  );
  let artistStr = artistNames.join("、");
  if (artistStr) {
    artistStr = `画师 ${artistStr}`;
  }

  const combined = [charStr, copyStr, artistStr]
    .filter(Boolean)
    .join(" ")
    .trim();
  return combined || `#${post.id}`;
}
