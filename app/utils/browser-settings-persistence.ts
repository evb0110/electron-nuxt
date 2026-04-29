import { sanitizeSettings } from '@contracts/settings';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';

export const BROWSER_SETTINGS_COOKIE_KEY = 'evb_viewer_settings';
export const BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const BROWSER_THEME_COOKIE_KEY = 'nuxt-color-mode';
export const BROWSER_LOCALE_COOKIE_KEY = 'i18n_redirected';

type TBrowserSettingsCookiePayload = Omit<ISettingsData, 'theme' | 'locale'>;

function parseRawBrowserSettingsPayload(raw: unknown): Partial<ISettingsData> | null {
    if (!raw) {
        return null;
    }

    if (typeof raw === 'object') {
        return raw;
    }

    if (typeof raw !== 'string') {
        return null;
    }

    try {
        return JSON.parse(raw) as Partial<ISettingsData>;
    } catch {
        return null;
    }
}

function isAppLocale(value: unknown): value is TAppLocale {
    return typeof value === 'string';
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

    const {
        theme: _theme,
        locale: _locale,
        ...rest
    } = settings;
    return rest;
}

export function parseBrowserSettingsPayload(
    raw: unknown,
    fallback: Partial<ISettingsData> | null = null,
) {
    const parsed = omitCookieBackedSettingsFields(parseRawBrowserSettingsPayload(raw));
    const normalizedFallback = fallback ? {
        ...fallback,
        locale: isAppLocale(fallback.locale) ? fallback.locale : undefined,
        theme: isAppTheme(fallback.theme) ? fallback.theme : undefined,
    } : null;
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
        suppressDefaultViewerPrompt: sanitized.suppressDefaultViewerPrompt,
        skippedUpdateVersion: sanitized.skippedUpdateVersion,
    };
    return JSON.stringify(payload);
}
