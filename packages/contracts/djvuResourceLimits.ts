// The browser viewer keeps a conservative metadata limit because it materializes
// the interactive page-size table. Electron desktop operations use their own
// bounded page schedulers and must not inherit this browser-only gate.
export const BROWSER_DJVU_INTERACTIVE_MAX_PAGES = 10_000;
export const DJVU_OUTLINE_MAX_DEPTH = 64;
export const DJVU_OUTLINE_MAX_NODES = 10_000;
export const DJVU_OUTLINE_MAX_TITLE_CHARS = 1_000_000;
export const DJVU_SEARCH_MAX_PAGE_TEXT_CHARS = 8 * 1024 * 1024;
export const DJVU_SEARCH_MAX_PAGE_ZONES = 200_000;
