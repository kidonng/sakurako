export interface DanbooruPostTitleMeta {
  readonly id: number;
  readonly tag_string_character: string;
  readonly tag_string_copyright: string;
  readonly tag_string_artist: string;
}

function splitTags(raw: string): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replaceAll("_", " "));
}
function toSentence(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0] ?? ""} and ${words[1] ?? ""}`;
  const initial = words.slice(0, -1).join(", ");
  const last = words[words.length - 1] ?? "";
  return `${initial}, and ${last}`;
}

export function formatDanbooruTitle(post: DanbooruPostTitleMeta): string {
  const charList = splitTags(post.tag_string_character);
  const chars = charList.slice(0, 5);
  if (charList.length > 5) {
    chars.push(`${charList.length - 5} more`);
  }
  const charStr = toSentence(chars);

  const copyList = splitTags(post.tag_string_copyright);
  const copies = copyList.slice(0, 1);
  if (copyList.length > 1) {
    copies.push(`${copyList.length - 1} more`);
  }
  let copyStr = toSentence(copies);
  if (charStr && copyStr) {
    copyStr = `(${copyStr})`;
  }

  const artistList = splitTags(post.tag_string_artist);
  let artistStr = toSentence(artistList);
  if (artistStr) {
    artistStr = `drawn by ${artistStr}`;
  }

  const combined = [charStr, copyStr, artistStr]
    .filter(Boolean)
    .join(" ")
    .trim();
  return combined || `#${post.id}`;
}
