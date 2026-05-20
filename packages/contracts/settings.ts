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
const DEFAULT_ZOOM_PRESETS: ReadonlySet<string> = new Set<ISettingsData['defaultZoomPreset']>([
    'fit-width',
    'fit-height',
    '100',
    '125',
    '150',
]);
const DEFAULT_VIEW_MODES: ReadonlySet<string> = new Set<ISettingsData['defaultViewMode']>([
    'single',
    'facing',
    'facing-first-single',
]);
const UI_SCALE_PREFERENCES: ReadonlySet<string> = new Set<ISettingsData['uiScale']>([
    'auto',
    'compact',
    'default',
    'comfortable',
    'large',
]);
const TAB_MEMORY_POLICIES: ReadonlySet<string> = new Set<ISettingsData['tabMemoryPolicy']>([
    'conservative',
    'aggressive',
]);
const MAX_AUTHOR_NAME_LENGTH = 256;
const MAX_SKIPPED_UPDATE_VERSION_LENGTH = 128;

export const DEFAULT_SETTINGS: ISettingsData = {
    version: 2,
    authorName: '',
    theme: 'light',
    locale: DEFAULT_LOCALE,
    defaultZoomPreset: 'fit-width',
    defaultViewMode: 'single',
    defaultContinuousScroll: true,
    defaultAnnotationColor: DEFAULT_ANNOTATION_COLOR,
    uiScale: 'auto',
    tabMemoryPolicy: 'conservative',
};

const SUPPORTED_LOCALES = new Set<string>(LOCALE_CODES);

function isLocale(locale: string): locale is TLocale {
    return SUPPORTED_LOCALES.has(locale);
}

function isDefaultZoomPreset(value: string): value is ISettingsData['defaultZoomPreset'] {
    return DEFAULT_ZOOM_PRESETS.has(value);
}

function isDefaultViewMode(value: string): value is ISettingsData['defaultViewMode'] {
    return DEFAULT_VIEW_MODES.has(value);
}

function isUiScalePreference(value: string): value is ISettingsData['uiScale'] {
    return UI_SCALE_PREFERENCES.has(value);
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

function normalizeBoundedString(value: unknown, maxLength: number) {
    if (!isString(value)) {
        return '';
    }

    return trim(value).slice(0, maxLength);
}

function normalizeDefaultZoomPreset(value: unknown): ISettingsData['defaultZoomPreset'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultZoomPreset;
    }

    return isDefaultZoomPreset(value)
        ? value
        : DEFAULT_SETTINGS.defaultZoomPreset;
}

function normalizeDefaultViewMode(value: unknown): ISettingsData['defaultViewMode'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultViewMode;
    }

    return isDefaultViewMode(value)
        ? value
        : DEFAULT_SETTINGS.defaultViewMode;
}

function normalizeDefaultAnnotationColor(value: unknown): string {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.defaultAnnotationColor;
    }

    const normalized = trim(value).toLowerCase();
    return isHexColor(normalized) ? normalized : DEFAULT_SETTINGS.defaultAnnotationColor;
}

function normalizeUiScale(value: unknown): ISettingsData['uiScale'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.uiScale;
    }

    return isUiScalePreference(value) ? value : DEFAULT_SETTINGS.uiScale;
}

function normalizeTabMemoryPolicy(value: unknown): ISettingsData['tabMemoryPolicy'] {
    if (!isString(value)) {
        return DEFAULT_SETTINGS.tabMemoryPolicy;
    }

    return TAB_MEMORY_POLICIES.has(value) ? value as ISettingsData['tabMemoryPolicy'] : DEFAULT_SETTINGS.tabMemoryPolicy;
}

export function sanitizeSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    const settings: ISettingsData = {
        version: typeof raw?.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
        authorName: normalizeBoundedString(raw?.authorName, MAX_AUTHOR_NAME_LENGTH),
        theme: normalizeTheme(raw?.theme),
        locale: normalizeLocale(raw?.locale),
        defaultZoomPreset: normalizeDefaultZoomPreset(raw?.defaultZoomPreset),
        defaultViewMode: normalizeDefaultViewMode(raw?.defaultViewMode),
        defaultContinuousScroll: isBoolean(raw?.defaultContinuousScroll)
            ? raw.defaultContinuousScroll
            : DEFAULT_SETTINGS.defaultContinuousScroll,
        defaultAnnotationColor: normalizeDefaultAnnotationColor(raw?.defaultAnnotationColor),
        uiScale: normalizeUiScale(raw?.uiScale),
        tabMemoryPolicy: normalizeTabMemoryPolicy(raw?.tabMemoryPolicy),
    };
    if (isBoolean(raw?.suppressDefaultViewerPrompt)) {
        settings.suppressDefaultViewerPrompt = raw.suppressDefaultViewerPrompt;
    }
    const skippedUpdateVersion = normalizeBoundedString(raw?.skippedUpdateVersion, MAX_SKIPPED_UPDATE_VERSION_LENGTH);
    if (skippedUpdateVersion) {
        settings.skippedUpdateVersion = skippedUpdateVersion;
    }
    return settings;
}
