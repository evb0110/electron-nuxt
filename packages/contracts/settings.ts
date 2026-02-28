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

export const DEFAULT_SETTINGS: ISettingsData = {
    version: 1,
    authorName: '',
    theme: 'light',
    locale: DEFAULT_LOCALE,
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

export function sanitizeSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    return {
        version: typeof raw?.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
        authorName: isString(raw?.authorName) ? raw.authorName : DEFAULT_SETTINGS.authorName,
        theme: normalizeTheme(raw?.theme),
        locale: normalizeLocale(raw?.locale),
        suppressDefaultViewerPrompt: isBoolean(raw?.suppressDefaultViewerPrompt)
            ? raw.suppressDefaultViewerPrompt
            : undefined,
        skippedUpdateVersion: isString(raw?.skippedUpdateVersion) && trim(raw.skippedUpdateVersion)
            ? trim(raw.skippedUpdateVersion)
            : undefined,
    };
}
