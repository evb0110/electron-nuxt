const DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main';

let cachedBaseUrl: string | null = null;

function normalizeBaseUrl(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, '');
}

export function configureBrowserOcrLanguageBaseUrl(baseUrl: string | undefined) {
    if (typeof baseUrl === 'string' && baseUrl.trim().length > 0) {
        cachedBaseUrl = normalizeBaseUrl(baseUrl);
    }
}

export function getBrowserOcrLanguageBaseUrl() {
    if (cachedBaseUrl !== null) {
        return cachedBaseUrl;
    }
    cachedBaseUrl = DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL;
    return cachedBaseUrl;
}
