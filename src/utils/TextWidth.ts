import stringWidth from "string-width";

export function truncate(
  text: string,
  maxWidth = 100,
  ellipsis = "...",
): string {
  const totalWidth = stringWidth(text);
  if (totalWidth <= maxWidth) {
    return text;
  }

  const ellipsisWidth = stringWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) {
    return ellipsis.slice(0, maxWidth);
  }

  const targetContentWidth = maxWidth - ellipsisWidth;
  let currentWidth = 0;
  let truncatedContent = "";

  const segmenter = new Intl.Segmenter();
  for (const { segment } of segmenter.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (currentWidth + segmentWidth > targetContentWidth) {
      break;
    }
    currentWidth += segmentWidth;
    truncatedContent += segment;
  }

  return truncatedContent + ellipsis;
}
