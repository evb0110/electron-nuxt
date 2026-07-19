import type {
    IScanCleanupOptions,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';

const SETTINGS_KEY = 'evb.scanCleanup.settings.v1';
const OVERRIDES_KEY = 'evb.scanCleanup.documentOverrides.v1';
const MAX_DOCUMENTS = 50;

export interface IScanCleanupGlobalPreferences extends Omit<IScanCleanupOptions, 'pageOverrides'> {runOcrAfterCleanup: boolean;}

export const DEFAULT_SCAN_CLEANUP_PREFERENCES: Readonly<IScanCleanupGlobalPreferences> = Object.freeze({
    layoutMode: 'auto',
    outputMode: 'bw',
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: 5,
    despeckle: true,
    skipBlankPages: false,
    straightenCurvedLines: false,
    runOcrAfterCleanup: false,
});

export interface IScanCleanupPreferenceStorage {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
}

const browserStorage: IScanCleanupPreferenceStorage = {
    get: safeGetLocalStorageItem,
    set: safeSetLocalStorageItem,
};

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function parseJson(raw: string | null) {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function toPlainScanCleanupOptions(options: IScanCleanupOptions): IScanCleanupOptions {
    return cloneJsonValue(options);
}

export function loadScanCleanupPreferences(
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupGlobalPreferences {
    const value = record(parseJson(storage.get(SETTINGS_KEY)));
    if (!value) {
        return {...DEFAULT_SCAN_CLEANUP_PREFERENCES};
    }
    const defaults = DEFAULT_SCAN_CLEANUP_PREFERENCES;
    return {
        layoutMode: [
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(value.layoutMode))
            ? value.layoutMode as IScanCleanupGlobalPreferences['layoutMode']
            : defaults.layoutMode,
        outputMode: [
            'bw',
            'grayscale',
            'color',
        ].includes(String(value.outputMode))
            ? value.outputMode as IScanCleanupGlobalPreferences['outputMode']
            : defaults.outputMode,
        readingOrder: value.readingOrder === 'rtl' ? 'rtl' : 'ltr',
        thickness: typeof value.thickness === 'number' ? Math.min(5, Math.max(-5, value.thickness)) : defaults.thickness,
        crop: typeof value.crop === 'boolean' ? value.crop : defaults.crop,
        matchPageSize: typeof value.matchPageSize === 'boolean' ? value.matchPageSize : defaults.matchPageSize,
        pageAlignment: typeof value.pageAlignment === 'string' && [
            'top-left',
            'top-center',
            'top-right',
            'center-left',
            'center',
            'center-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ].includes(value.pageAlignment)
            ? value.pageAlignment as IScanCleanupGlobalPreferences['pageAlignment']
            : defaults.pageAlignment,
        marginsMm: typeof value.marginsMm === 'number' ? Math.min(25, Math.max(0, value.marginsMm)) : defaults.marginsMm,
        despeckle: typeof value.despeckle === 'boolean' ? value.despeckle : defaults.despeckle,
        skipBlankPages: typeof value.skipBlankPages === 'boolean' ? value.skipBlankPages : defaults.skipBlankPages,
        straightenCurvedLines: typeof value.straightenCurvedLines === 'boolean'
            ? value.straightenCurvedLines
            : defaults.straightenCurvedLines,
        runOcrAfterCleanup: typeof value.runOcrAfterCleanup === 'boolean'
            ? value.runOcrAfterCleanup
            : defaults.runOcrAfterCleanup,
    };
}

export function saveScanCleanupPreferences(
    value: IScanCleanupGlobalPreferences,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    storage.set(SETTINGS_KEY, JSON.stringify(value));
}

interface IDocumentOverrideEntry {
    updatedAt: number;
    overrides: TScanCleanupPageOverrides;
}

function loadDocumentEntries(storage: IScanCleanupPreferenceStorage) {
    const value = record(parseJson(storage.get(OVERRIDES_KEY)));
    return value ?? {};
}

export function loadScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): TScanCleanupPageOverrides {
    if (!documentKey) {
        return {};
    }
    const entry = record(loadDocumentEntries(storage)[documentKey]);
    const overrides = record(entry?.overrides);
    return overrides ? structuredClone(overrides) as TScanCleanupPageOverrides : {};
}

export function saveScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    overrides: TScanCleanupPageOverrides,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        updatedAt: Date.now(),
        overrides: cloneJsonValue(overrides),
    } satisfies IDocumentOverrideEntry;
    const bounded = Object.fromEntries(Object.entries(entries)
        .sort((left, right) => Number(record(right[1])?.updatedAt ?? 0) - Number(record(left[1])?.updatedAt ?? 0))
        .slice(0, MAX_DOCUMENTS));
    storage.set(OVERRIDES_KEY, JSON.stringify(bounded));
}

export function resetScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    Reflect.deleteProperty(entries, documentKey);
    storage.set(OVERRIDES_KEY, JSON.stringify(entries));
}
