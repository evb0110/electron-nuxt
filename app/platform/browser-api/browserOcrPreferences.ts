import { uniq } from 'es-toolkit/array';
import type {
    IOcrSettings,
    TOcrPageRange,
} from '@app/utils/ocr/languages';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { OCR_SETTINGS_STORAGE_KEY } from '@app/platform/browser-api/browserApiStorageKeys';

const DEFAULT_BROWSER_OCR_SETTINGS: IOcrSettings = {
    pageRange: 'current',
    customRange: '',
    selectedLanguages: ['eng'],
};

const VALID_PAGE_RANGES: ReadonlySet<string> = new Set<TOcrPageRange>([
    'all',
    'current',
    'custom',
]);

function isOcrPageRange(value: string): value is TOcrPageRange {
    return VALID_PAGE_RANGES.has(value);
}

function sanitizeSelectedLanguages(value: unknown) {
    if (!Array.isArray(value)) {
        return [...DEFAULT_BROWSER_OCR_SETTINGS.selectedLanguages];
    }

    const languages = value
        .map(language => typeof language === 'string' ? language.trim() : '')
        .filter((language): language is string => language.length > 0);

    return languages.length > 0
        ? uniq(languages)
        : [...DEFAULT_BROWSER_OCR_SETTINGS.selectedLanguages];
}

function sanitizePageRange(value: unknown): TOcrPageRange {
    return typeof value === 'string' && isOcrPageRange(value)
        ? value
        : DEFAULT_BROWSER_OCR_SETTINGS.pageRange;
}

export function sanitizeBrowserOcrSettings(value: unknown): IOcrSettings {
    const raw = value && typeof value === 'object'
        ? value as Partial<IOcrSettings>
        : {};

    return {
        pageRange: sanitizePageRange(raw.pageRange),
        customRange: typeof raw.customRange === 'string'
            ? raw.customRange
            : DEFAULT_BROWSER_OCR_SETTINGS.customRange,
        selectedLanguages: sanitizeSelectedLanguages(raw.selectedLanguages),
    };
}

export function readBrowserOcrPreferences(): IOcrSettings | null {
    const rawValue = safeGetLocalStorageItem(OCR_SETTINGS_STORAGE_KEY);
    if (!rawValue) {
        return null;
    }

    try {
        return sanitizeBrowserOcrSettings(JSON.parse(rawValue));
    } catch {
        return null;
    }
}

export function saveBrowserOcrPreferences(settings: IOcrSettings) {
    safeSetLocalStorageItem(
        OCR_SETTINGS_STORAGE_KEY,
        JSON.stringify(sanitizeBrowserOcrSettings(settings)),
    );
}

export function getDefaultBrowserOcrSettings(): IOcrSettings {
    return {
        pageRange: DEFAULT_BROWSER_OCR_SETTINGS.pageRange,
        customRange: DEFAULT_BROWSER_OCR_SETTINGS.customRange,
        selectedLanguages: [...DEFAULT_BROWSER_OCR_SETTINGS.selectedLanguages],
    };
}
