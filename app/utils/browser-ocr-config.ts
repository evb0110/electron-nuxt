const DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main';

export function getBrowserOcrLanguageBaseUrl() {
    if (typeof useRuntimeConfig === 'function') {
        const configured = useRuntimeConfig().public?.browserOcrLanguageBaseUrl;
        if (typeof configured === 'string' && configured.trim().length > 0) {
            return configured.trim().replace(/\/+$/, '');
        }
    }

    return DEFAULT_BROWSER_OCR_LANGUAGE_BASE_URL;
}
