const INVALID_TITLE_PATTERNS = [
  /^(React App|Vite App|Create React App)$/i,
  /^(Loading(\.\.\.)?|加载中(\.\.\.)?)$/i,
  /^(404( Not Found)?|403( Forbidden)?|500( Internal Server Error)?|Not Found|Error)$/i,
  /^(页面未找到|网页不存在)$/i,
];

const GENERIC_ICON_PATTERNS = [
  /(^|[-_./])(logo|favicon|avatar|icon|chevron|arrow|spinner|placeholder)([-_./]|$)/i,
];

export function isInvalidTitle(title: string | undefined): boolean {
  if (!title) {
    return true;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return INVALID_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isGenericIconUrl(url: string | undefined): boolean {
  if (!url || url.trim().length === 0) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const pathAndQuery = `${parsed.pathname}${parsed.search}`;
    return GENERIC_ICON_PATTERNS.some((pattern) => pattern.test(pathAndQuery));
  } catch {
    return GENERIC_ICON_PATTERNS.some((pattern) => pattern.test(url));
  }
}
