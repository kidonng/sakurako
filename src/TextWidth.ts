const CJK_REGEX =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u

export function getCharacterWidth(char: string): number {
  if (char.length === 0) return 0
  return CJK_REGEX.test(char) || (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1
}

export function getStringWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += getCharacterWidth(char)
  }
  return width
}

export function truncate(text: string, maxWidth = 100, ellipsis = "..."): string {
  const totalWidth = getStringWidth(text)
  if (totalWidth <= maxWidth) {
    return text
  }

  const ellipsisWidth = getStringWidth(ellipsis)
  const targetContentWidth = maxWidth - ellipsisWidth
  let currentWidth = 0
  let truncatedContent = ""

  for (const char of text) {
    const charWidth = getCharacterWidth(char)
    if (currentWidth + charWidth > targetContentWidth) {
      break
    }
    currentWidth += charWidth
    truncatedContent += char
  }

  return truncatedContent + ellipsis
}
