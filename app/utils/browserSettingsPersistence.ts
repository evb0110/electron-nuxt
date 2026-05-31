import { omit } from 'es-toolkit/object';
import { sanitizeSettings } from '@contracts/settings';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
import { LOCALE_CODES } from '@i18n-core';

export const BROWSER_SETTINGS_COOKIE_KEY = 'evb_viewer_settings';
export const BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const BROWSER_THEME_COOKIE_KEY = 'nuxt-color-mode';
export const BROWSER_LOCALE_COOKIE_KEY = 'i18n_redirected';

type TBrowserSettingsCookiePayload = Omit<ISettingsData, 'theme' | 'locale'>;
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<TAppLocale>(LOCALE_CODES);

function isSettingsPatch(value: unknown): value is Partial<ISettingsData> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRawBrowserSettingsPayload(raw: unknown): Partial<ISettingsData> | null {
    if (!raw) {
        return null;
    }

    if (isSettingsPatch(raw)) {
        return raw;
    }

    if (typeof raw !== 'string') {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        return isSettingsPatch(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isAppLocale(value: unknown): value is TAppLocale {
    return typeof value === 'string' && SUPPORTED_LOCALES.has(value);
}

function isAppTheme(value: unknown): value is TAppTheme {
    return value === 'light' || value === 'dark';
}

function omitCookieBackedSettingsFields<T extends Partial<ISettingsData> | null>(
    settings: T,
) : Omit<NonNullable<T>, 'theme' | 'locale'> | null {
    if (!settings) {
        return null;
    }

    return omit(settings, [
        'theme',
        'locale',
    ]);
}

export function parseBrowserSettingsPayload(
    raw: unknown,
    fallback: Partial<ISettingsData> | null = null,
) {
    const parsed = omitCookieBackedSettingsFields(parseRawBrowserSettingsPayload(raw));
    const normalizedFallback = fallback ? { ...fallback } : null;
    if (normalizedFallback && !isAppLocale(normalizedFallback.locale)) {
        delete normalizedFallback.locale;
    }
    if (normalizedFallback && !isAppTheme(normalizedFallback.theme)) {
        delete normalizedFallback.theme;
    }
    return sanitizeSettings({
        ...parsed,
        ...normalizedFallback,
    });
}

export function serializeBrowserSettingsPayload(settings: ISettingsData) {
    const sanitized = sanitizeSettings(settings);
    const payload: TBrowserSettingsCookiePayload = {
        version: sanitized.version,
        authorName: sanitized.authorName,
        defaultZoomPreset: sanitized.defaultZoomPreset,
        defaultViewMode: sanitized.defaultViewMode,
        defaultContinuousScroll: sanitized.defaultContinuousScroll,
        defaultAnnotationColor: sanitized.defaultAnnotationColor,
        uiScale: sanitized.uiScale,
        tabMemoryPolicy: sanitized.tabMemoryPolicy,
    };
    if (sanitized.suppressDefaultViewerPrompt !== undefined) {
        payload.suppressDefaultViewerPrompt = sanitized.suppressDefaultViewerPrompt;
    }
    if (sanitized.skippedUpdateVersion !== undefined) {
        payload.skippedUpdateVersion = sanitized.skippedUpdateVersion;
    }
    return JSON.stringify(payload);
}
