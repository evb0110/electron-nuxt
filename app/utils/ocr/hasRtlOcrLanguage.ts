const RTL_OCR_LANGUAGES: ReadonlySet<string> = new Set([
    'ara',
    'heb',
    'syr',
]);

export function hasRtlOcrLanguage(languages: readonly string[]) {
    return languages.some(lang => RTL_OCR_LANGUAGES.has(lang));
}
