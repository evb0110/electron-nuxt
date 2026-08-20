import { omit } from 'es-toolkit/object';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    ISettingsData,
    TAppLocale,
    TAppTheme,
} from '@contracts/shared';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import { LOCALE_CODES } from '@i18n-core';
import { safeDecodeURIComponent } from '@app/utils/browserSafe';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

export const BROWSER_SETTINGS_COOKIE_KEY = 'evb_viewer_settings';
export const BROWSER_SETTINGS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const BROWSER_THEME_COOKIE_KEY = 'nuxt-color-mode';
export const BROWSER_LOCALE_COOKIE_KEY = 'i18n_redirected';

type TBrowserSettingsCookiePayload = Omit<ISettingsData, 'agentMcpEnabled' | 'theme' | 'locale'>;
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<TAppLocale>(LOCALE_CODES);

function parseRawBrowserSettingsPayload(raw: unknown): Record<PropertyKey, unknown> | null {
    if (!raw) {
        return null;
    }

    if (isRecord(raw)) {
        return raw;
    }

    if (typeof raw !== 'string') {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function hasExpectedSettingsShape(
    value: Record<PropertyKey, unknown> | null,
    requireBrowserOnlyFields: boolean,
) {
    if (!value
        || typeof value.version !== 'number'
        || !Number.isInteger(value.version)
        || value.version < 1
        || value.version > DEFAULT_SETTINGS.version
        || typeof value.authorName !== 'string'
        || typeof value.defaultZoomPreset !== 'string'
        || typeof value.defaultViewMode !== 'string'
        || typeof value.defaultContinuousScroll !== 'boolean'
        || typeof value.defaultAnnotationColor !== 'string'
        || typeof value.uiScale !== 'string'
        || typeof value.tabMemoryPolicy !== 'string'
        || typeof value.performanceMode !== 'string'
        || typeof value.optimizePdfOnSaveAs !== 'boolean'
        || typeof value.assistantPanelEnabled !== 'boolean') {
        return false;
    }

    return !requireBrowserOnlyFields || (
        isAppLocale(value.locale)
        && isAppTheme(value.theme)
        && typeof value.agentMcpEnabled === 'boolean'
    );
}

export function isValidLegacyBrowserSettingsPayload(raw: unknown) {
    return hasExpectedSettingsShape(parseRawBrowserSettingsPayload(raw), false);
}

export function isValidBrowserSettingsStoragePayload(raw: unknown) {
    return hasExpectedSettingsShape(parseRawBrowserSettingsPayload(raw), true);
}

function isAppLocale(value: unknown): value is TAppLocale {
    return typeof value === 'string' && SUPPORTED_LOCALES.has(value);
}

function isAppTheme(value: unknown): value is TAppTheme {
    return value === 'light' || value === 'dark';
}

function omitCookieBackedSettingsFields<T extends Record<PropertyKey, unknown> | null>(
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
        performanceMode: sanitized.performanceMode,
        optimizePdfOnSaveAs: sanitized.optimizePdfOnSaveAs,
        assistantPanelEnabled: sanitized.assistantPanelEnabled,
    };
    if (sanitized.suppressDefaultViewerPrompt !== undefined) {
        payload.suppressDefaultViewerPrompt = sanitized.suppressDefaultViewerPrompt;
    }
    if (sanitized.skippedUpdateVersion !== undefined) {
        payload.skippedUpdateVersion = sanitized.skippedUpdateVersion;
    }
    return JSON.stringify(payload);
}

export function expireLegacyBrowserSettingsCookie() {
    if (typeof document === 'undefined') {
        return;
    }
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${BROWSER_SETTINGS_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secureAttribute}`;
}

function readRawSettingsCookie(): string | null {
    if (typeof document === 'undefined') {
        return null;
    }

    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const separatorIndex = cookie.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const name = cookie.slice(0, separatorIndex).trim();
        if (name === BROWSER_SETTINGS_COOKIE_KEY) {
            return safeDecodeURIComponent(cookie.slice(separatorIndex + 1).trim());
        }
    }

    return null;
}

export function readBrowserPerformanceModeSnapshot(): TPerformanceMode {
    const legacyCookie = readRawSettingsCookie();
    if (legacyCookie !== null) {
        const isValidLegacyCookie = isValidLegacyBrowserSettingsPayload(legacyCookie);
        if (isValidLegacyCookie) {
            const migratedSettings = parseBrowserSettingsPayload(legacyCookie);
            safeSetLocalStorageItem(
                BROWSER_SETTINGS_STORAGE_KEY,
                JSON.stringify(migratedSettings),
            );
            expireLegacyBrowserSettingsCookie();
            return migratedSettings.performanceMode;
        }
        expireLegacyBrowserSettingsCookie();
    }

    const storageSnapshot = safeGetLocalStorageItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (isValidBrowserSettingsStoragePayload(storageSnapshot)) {
        return parseBrowserSettingsPayload(storageSnapshot).performanceMode;
    }
    return 'auto';
}
