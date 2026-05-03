const DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main';

let cachedBaseUrl: string | null = null;

function readConfiguredBaseUrl() {
    if (typeof useRuntimeConfig !== 'function') {
        return null;
    }
    try {
        const configured = useRuntimeConfig().public?.browserOcrLanguageBaseUrl;
        if (typeof configured === 'string' && configured.trim().length > 0) {
            return configured.trim().replace(/\/+$/, '');
        }
    } catch {
        return null;
    }
    return null;
}

export function getBrowserOcrLanguageBaseUrl() {
    if (cachedBaseUrl !== null) {
        return cachedBaseUrl;
    }
    cachedBaseUrl = readConfiguredBaseUrl() ?? DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL;
    return cachedBaseUrl;
}
