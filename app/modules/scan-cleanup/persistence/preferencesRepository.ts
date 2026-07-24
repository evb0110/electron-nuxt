import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    migrateScanCleanupDocumentOverridesV1,
    warnScanCleanupOverrideMigrationV1,
} from '@app/modules/scan-cleanup/persistence/migrations/v1';
import {
    assertFiniteScanCleanupPreferences,
    cloneScanCleanupPreferenceValue,
    decodeScanCleanupGlobalPreferences,
    decodeScanCleanupMarginsMm,
    parseScanCleanupPreferenceJson,
    scanCleanupPreferenceRecord,
    type IScanCleanupGlobalPreferences,
} from '@app/modules/scan-cleanup/persistence/preferencesSchema';

const SETTINGS_KEY = 'evb.scanCleanup.settings.v1';
const OVERRIDES_KEY = 'evb.scanCleanup.documentOverrides.v1';
const MAX_DOCUMENTS = 50;
export const DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE: TScanCleanupOutputModeSetting = 'auto';

export interface IScanCleanupPreferenceStorage {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
}

const browserStorage: IScanCleanupPreferenceStorage = {
    get: safeGetLocalStorageItem,
    set: safeSetLocalStorageItem,
};

function loadDocumentEntries(storage: IScanCleanupPreferenceStorage) {
    return scanCleanupPreferenceRecord(parseScanCleanupPreferenceJson(storage.get(OVERRIDES_KEY))) ?? {};
}

function boundedDocumentEntries(entries: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(entries)
        .sort((left, right) => {
            const rightUpdatedAt = scanCleanupPreferenceRecord(right[1])?.updatedAt;
            const leftUpdatedAt = scanCleanupPreferenceRecord(left[1])?.updatedAt;
            return (typeof rightUpdatedAt === 'number' && Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0)
                - (typeof leftUpdatedAt === 'number' && Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0);
        })
        .slice(0, MAX_DOCUMENTS));
}

export function loadScanCleanupPreferences(
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    return decodeScanCleanupGlobalPreferences(parseScanCleanupPreferenceJson(storage.get(SETTINGS_KEY)));
}

export function saveScanCleanupPreferences(
    value: IScanCleanupGlobalPreferences,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    assertFiniteScanCleanupPreferences(value);
    const {
        outputMode: _ignoredLegacyOutputMode,
        runOcrAfterCleanup: _ignoredLegacyRunOcr,
        ...globalPreferences
    } = value as IScanCleanupGlobalPreferences & {
        outputMode?: unknown;
        runOcrAfterCleanup?: unknown;
    };
    storage.set(SETTINGS_KEY, JSON.stringify({
        ...globalPreferences,
        marginsMm: decodeScanCleanupMarginsMm(value.marginsMm),
    }));
}

export function dismissScanCleanupFirstRunGuidance(
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    const preferences = loadScanCleanupPreferences(storage);
    if (!preferences.firstRunGuidanceDismissed) {
        saveScanCleanupPreferences({
            ...preferences,
            firstRunGuidanceDismissed: true,
        }, storage);
    }
}

export function toPlainScanCleanupOptions(value: IScanCleanupOptions): IScanCleanupOptions {
    return cloneScanCleanupPreferenceValue(value);
}

export function loadScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): TScanCleanupPageOverrides {
    if (!documentKey) {
        return {};
    }
    const entries = loadDocumentEntries(storage);
    const entry = scanCleanupPreferenceRecord(entries[documentKey]);
    const migration = migrateScanCleanupDocumentOverridesV1(entry);
    if (migration.migratedLegacyGeometry) {
        entries[documentKey] = {
            ...(entry ?? {}),
            overrides: migration.overrides,
        };
        storage.set(OVERRIDES_KEY, JSON.stringify(entries));
        warnScanCleanupOverrideMigrationV1();
    }
    return migration.overrides;
}

export function loadScanCleanupDocumentMargins(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupMarginsMm | null {
    if (!documentKey) {
        return null;
    }
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    const marginsMm = scanCleanupPreferenceRecord(entry?.marginsMm);
    if (!marginsMm) {
        return null;
    }
    return decodeScanCleanupMarginsMm(marginsMm);
}

export function loadScanCleanupDocumentOutputMode(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): TScanCleanupOutputModeSetting {
    if (!documentKey) {
        return DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE;
    }
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    return [
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(entry?.outputMode))
        ? entry?.outputMode as TScanCleanupOutputModeSetting
        : DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE;
}

export function saveScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    overrides: TScanCleanupPageOverrides,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const plainOverrides = cloneScanCleanupPreferenceValue(overrides);
    const validatedOverrides = migrateScanCleanupDocumentOverridesV1({overrides: plainOverrides}).overrides;
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        overrides: validatedOverrides,
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function saveScanCleanupDocumentMargins(
    documentKey: string | null | undefined,
    marginsMm: IScanCleanupMarginsMm,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    if (Object.values(marginsMm).some(margin => !Number.isFinite(margin))) {
        throw new TypeError('Scan cleanup document margins require finite numeric values');
    }
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        marginsMm: decodeScanCleanupMarginsMm(marginsMm),
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function saveScanCleanupDocumentOutputMode(
    documentKey: string | null | undefined,
    outputMode: TScanCleanupOutputModeSetting,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey || ![
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(outputMode)) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        outputMode,
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function resetScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    const entry = scanCleanupPreferenceRecord(entries[documentKey]);
    if (entry?.marginsMm !== undefined || entry?.outputMode !== undefined) {
        Reflect.deleteProperty(entry, 'overrides');
        entries[documentKey] = entry;
    } else {
        Reflect.deleteProperty(entries, documentKey);
    }
    storage.set(OVERRIDES_KEY, JSON.stringify(entries));
}
