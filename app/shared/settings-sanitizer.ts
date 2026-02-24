import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    type TLocale,
} from '@app/i18n/locale-codes';
import type { ISettingsData } from '@app/types/shared';

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
    if (typeof locale !== 'string') {
        return DEFAULT_LOCALE;
    }

    return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

export function sanitizeSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    return {
        version: typeof raw?.version === 'number' ? raw.version : DEFAULT_SETTINGS.version,
        authorName: typeof raw?.authorName === 'string' ? raw.authorName : DEFAULT_SETTINGS.authorName,
        theme: normalizeTheme(raw?.theme),
        locale: normalizeLocale(raw?.locale),
        suppressDefaultViewerPrompt: typeof raw?.suppressDefaultViewerPrompt === 'boolean'
            ? raw.suppressDefaultViewerPrompt
            : undefined,
        skippedUpdateVersion: typeof raw?.skippedUpdateVersion === 'string' && raw.skippedUpdateVersion.trim()
            ? raw.skippedUpdateVersion.trim()
            : undefined,
    };
}
