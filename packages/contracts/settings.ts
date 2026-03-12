import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    type TLocale,
} from '@i18n-core';
import {
    isBoolean,
    isString,
} from 'es-toolkit/predicate';
import { trim } from 'es-toolkit/string';
import type { ISettingsData } from './shared';

const DEFAULT_ANNOTATION_COLOR = '#ffd400';
const DEFAULT_ZOOM_PRESETS = new Set<ISettingsData['defaultZoomPreset']>([
    'fit-width',
    'fit-height',
    '100',
    '125',
    '150',
]);
const DEFAULT_VIEW_MODES = new Set<ISettingsData['defaultViewMode']>([
    'single',
    'facing',
    'facing-first-single',
]);

export const DEFAULT_SETTINGS: ISettingsData = {
    version: 2,
    authorName: '',
    theme: 'light',
    locale: DEFAULT_LOCALE,
    defaultZoomPreset: 'fit-width',
    defaultViewMode: 'single',
    defaultContinuousScroll: true,
    defaultAnnotationColor: DEFAULT_ANNOTATION_COLOR,
};

const SUPPORTED_LOCALES = new Set<string>(LOCALE_CODES);

function isLocale(locale: string): locale is TLocale {
    return SUPPORTED_LOCALES.has(locale);
}

export function normalizeTheme(theme: unknown): ISettingsData['theme'] {
    return theme === 'dark' ? 'dark' : 'light';
}

export function normalizeLocale(locale: unknown): TLocale {
    if (!isString(locale)) {
        return DEFAULT_LOCALE;
    }

    return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

function isHexColor(value: string) {
    return /^#[\da-f]{6}$/iu.test(value.trim());
}

function normalizeDefaultZoomPreset(value: unknown): ISettingsData['defaultZoomPreset'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultZoomPreset;
    }

    return DEFAULT_ZOOM_PRESETS.has(value as ISettingsData['defaultZoomPreset'])
        ? value as ISettingsData['defaultZoomPreset']
        : DEFAULT_SETTINGS.defaultZoomPreset;
}

function normalizeDefaultViewMode(value: unknown): ISettingsData['defaultViewMode'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultViewMode;
    }

    return DEFAULT_VIEW_MODES.has(value as ISettingsData['defaultViewMode'])
        ? value as ISettingsData['defaultViewMode']
        : DEFAULT_SETTINGS.defaultViewMode;
}

function normalizeDefaultAnnotationColor(value: unknown): string {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultAnnotationColor;
    }

    const normalized = trim(value).toLowerCase();
    return isHexColor(normalized) ? normalized : DEFAULT_SETTINGS.defaultAnnotationColor;
}

export function sanitizeSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    return {
        version: typeof raw?.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
        authorName: isString(raw?.authorName) ? raw.authorName : DEFAULT_SETTINGS.authorName,
        theme: normalizeTheme(raw?.theme),
        locale: normalizeLocale(raw?.locale),
        defaultZoomPreset: normalizeDefaultZoomPreset(raw?.defaultZoomPreset),
        defaultViewMode: normalizeDefaultViewMode(raw?.defaultViewMode),
        defaultContinuousScroll: isBoolean(raw?.defaultContinuousScroll)
            ? raw.defaultContinuousScroll
            : DEFAULT_SETTINGS.defaultContinuousScroll,
        defaultAnnotationColor: normalizeDefaultAnnotationColor(raw?.defaultAnnotationColor),
        suppressDefaultViewerPrompt: isBoolean(raw?.suppressDefaultViewerPrompt)
            ? raw.suppressDefaultViewerPrompt
            : undefined,
        skippedUpdateVersion: isString(raw?.skippedUpdateVersion) && trim(raw.skippedUpdateVersion)
            ? trim(raw.skippedUpdateVersion)
            : undefined,
    };
}
