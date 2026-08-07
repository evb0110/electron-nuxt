import type {
    IScanCleanupMarginsMm,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    cloneScanCleanupPreferenceValue,
    createDefaultScanCleanupSettingsFile,
    isScanCleanupSourceSha256,
    type IScanCleanupDocumentPreferencePatch,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
    type IScanCleanupSettingsUpdateRequest,
} from '@contracts/scanCleanupSettings';
import type {EffectScope} from 'vue';
import {isEqual} from 'es-toolkit/predicate';
import {
    clearScanCleanupLegacyStorage,
    exportScanCleanupLegacyStorage,
    loadScanCleanupDocumentMargins,
    loadScanCleanupDocumentOutputMode,
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    saveScanCleanupDocumentPreferences,
    saveScanCleanupPreferences,
    SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {isDesktopPlatformActive} from '@app/utils/platform';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

interface IScanCleanupPreferencesStoreOptions {
    sourceSha256?: string | null;
    legacyDocumentKey?: string | null;
}

export interface IScanCleanupDocumentSettingsSnapshot {
    overrides: TScanCleanupPageOverrides;
    marginsMm: IScanCleanupMarginsMm | null;
    outputMode: TScanCleanupOutputModeSetting;
}

let preferences: IScanCleanupGlobalPreferences | null = null;
let persistenceScope: EffectScope | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: IScanCleanupGlobalPreferences | null = null;
let lifecycleListenersRegistered = false;
let desktopStore = false;
let preferencesHydrated = false;
let preferencesHydrationPromise: Promise<void> | null = null;
let remoteSettingsFile: IScanCleanupSettingsFile | null = null;
let remoteWriteQueue = Promise.resolve();
let migrationContext: IScanCleanupPreferencesStoreOptions = {};
let applyingRemotePreferences = false;
const documentPersistenceEpochs = new Map<string, number>();

export interface IScanCleanupDocumentPersistenceToken {
    legacyDocumentKey: string | null;
    legacyDocumentKeyEpoch: number;
    sourceSha256: string | null;
    sourceSha256Epoch: number;
}

function documentPersistenceEpochKey(kind: 'legacy' | 'sha256', value: string | null | undefined) {
    if (!value) {
        return null;
    }
    return `${kind}:${kind === 'sha256' ? value.toLowerCase() : value}`;
}

function readDocumentPersistenceEpoch(key: string | null) {
    return key === null ? 0 : documentPersistenceEpochs.get(key) ?? 0;
}

export function captureScanCleanupDocumentPersistenceToken(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
): IScanCleanupDocumentPersistenceToken {
    const normalizedSourceSha256 = sourceSha256?.toLowerCase() ?? null;
    const normalizedLegacyDocumentKey = legacyDocumentKey ?? null;
    return {
        sourceSha256: normalizedSourceSha256,
        sourceSha256Epoch: readDocumentPersistenceEpoch(
            documentPersistenceEpochKey('sha256', normalizedSourceSha256),
        ),
        legacyDocumentKey: normalizedLegacyDocumentKey,
        legacyDocumentKeyEpoch: readDocumentPersistenceEpoch(
            documentPersistenceEpochKey('legacy', normalizedLegacyDocumentKey),
        ),
    };
}

export function isScanCleanupDocumentPersistenceTokenCurrent(
    token: IScanCleanupDocumentPersistenceToken,
) {
    return token.sourceSha256Epoch === readDocumentPersistenceEpoch(
        documentPersistenceEpochKey('sha256', token.sourceSha256),
    ) && token.legacyDocumentKeyEpoch === readDocumentPersistenceEpoch(
        documentPersistenceEpochKey('legacy', token.legacyDocumentKey),
    );
}

export function invalidateScanCleanupDocumentPersistence(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
) {
    for (const key of [
        documentPersistenceEpochKey('sha256', sourceSha256),
        documentPersistenceEpochKey('legacy', legacyDocumentKey),
    ]) {
        if (key !== null) {
            documentPersistenceEpochs.set(key, readDocumentPersistenceEpoch(key) + 1);
        }
    }
}

function currentScanCleanupCapability() {
    const capability = getScanCleanupCapability();
    if (!capability) {
        throw new Error('Scan Cleanup platform capability is unavailable');
    }
    return capability;
}

async function readRemoteSettings(request: IScanCleanupSettingsReadRequest) {
    const getSettings = currentScanCleanupCapability().getSettings;
    if (!getSettings) {
        throw new Error('File-backed scan-cleanup settings are unavailable');
    }
    return getSettings(request);
}

function updateMigrationContext(options: IScanCleanupPreferencesStoreOptions | undefined) {
    if (!options) {
        return;
    }
    migrationContext = {
        ...(options.sourceSha256 === undefined ? {} : {sourceSha256: options.sourceSha256}),
        ...(options.legacyDocumentKey === undefined ? {} : {legacyDocumentKey: options.legacyDocumentKey}),
    };
}

function warnMissingDocumentSourceHash(action: 'load' | 'persist', legacyDocumentKey: string | null | undefined) {
    BrowserLogger.warn(
        'scan-cleanup',
        `Cannot ${action} document preferences without the authoritative source SHA-256`,
        () => ({
            reason: 'missing-authoritative-source-sha256',
            hasLegacyDocumentKey: Boolean(legacyDocumentKey),
        }),
    );
}

function createSettingsReadRequest(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    includeLegacyStorage = false,
): IScanCleanupSettingsReadRequest {
    return {
        ...(includeLegacyStorage ? {legacyStorage: exportScanCleanupLegacyStorage()} : {}),
        ...(sourceSha256 === undefined ? {} : {sourceSha256}),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
    };
}

function queueRemoteUpdate(
    request: IScanCleanupSettingsUpdateRequest,
) {
    remoteWriteQueue = remoteWriteQueue.then(async () => {
        const updateSettings = currentScanCleanupCapability().updateSettings;
        if (!updateSettings) {
            throw new Error('File-backed scan-cleanup settings are unavailable');
        }
        const result = await updateSettings(request);
        remoteSettingsFile = result;
    }).catch(error => {
        BrowserLogger.error('scan-cleanup', 'Failed to persist file-backed settings', error);
    });
}

async function hydratePreferences() {
    if (!desktopStore || !preferences) {
        preferencesHydrated = true;
        return;
    }
    try {
        const result = await readRemoteSettings(createSettingsReadRequest(
            migrationContext.sourceSha256,
            migrationContext.legacyDocumentKey,
            true,
        ));
        remoteSettingsFile = result;
        applyingRemotePreferences = true;
        Object.assign(preferences, result.settings);
        await nextTick();
        clearScanCleanupLegacyStorage();
    } catch (error) {
        BrowserLogger.error('scan-cleanup', 'Failed to load file-backed settings', error);
    } finally {
        applyingRemotePreferences = false;
        preferencesHydrated = true;
    }
}

function scheduleScanCleanupPreferencesPersistence(value: IScanCleanupGlobalPreferences) {
    if (!preferencesHydrated || applyingRemotePreferences) {
        return;
    }
    pendingPreferences = cloneScanCleanupPreferenceValue(value);
    if (persistenceTimer !== null) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(flushScanCleanupPreferencesStore, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
}

export function flushScanCleanupPreferencesStore() {
    if (persistenceTimer !== null) {
        clearTimeout(persistenceTimer);
        persistenceTimer = null;
    }
    const pending = pendingPreferences;
    pendingPreferences = null;
    if (!pending || !preferencesHydrated) {
        return;
    }
    if (desktopStore) {
        if (remoteSettingsFile && isEqual(pending, remoteSettingsFile.settings)) {
            return;
        }
        queueRemoteUpdate({settings: pending});
    } else {
        saveScanCleanupPreferences(pending);
    }
}

function handleWindowLifecycle() {
    flushScanCleanupPreferencesStore();
}

function registerLifecycleListeners() {
    if (lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = true;
    window.addEventListener('beforeunload', handleWindowLifecycle);
    window.addEventListener('pagehide', handleWindowLifecycle);
}

function unregisterLifecycleListeners() {
    if (!lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = false;
    window.removeEventListener('beforeunload', handleWindowLifecycle);
    window.removeEventListener('pagehide', handleWindowLifecycle);
}

/** Renderer-wide global preferences shared by every mounted scan-cleanup surface. */
export function getScanCleanupPreferencesStore(options?: IScanCleanupPreferencesStoreOptions) {
    updateMigrationContext(options);
    if (preferences) {
        return preferences;
    }
    desktopStore = isDesktopPlatformActive();
    const initialPreferences = desktopStore
        ? cloneScanCleanupPreferenceValue(createDefaultScanCleanupSettingsFile().settings)
        : loadScanCleanupPreferences();
    const sharedPreferences = reactive(initialPreferences);
    preferences = sharedPreferences;
    preferencesHydrated = !desktopStore;
    preferencesHydrationPromise = desktopStore ? hydratePreferences() : Promise.resolve();
    persistenceScope = effectScope(true);
    persistenceScope.run(() => {
        watch(sharedPreferences, value => {
            scheduleScanCleanupPreferencesPersistence(value);
        }, {deep: true});
    });
    registerLifecycleListeners();
    return preferences;
}

export function whenScanCleanupPreferencesReady(): Promise<void> {
    return preferencesHydrationPromise ?? Promise.resolve();
}

export function loadScanCleanupDocumentSettings(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
): IScanCleanupDocumentSettingsSnapshot | Promise<IScanCleanupDocumentSettingsSnapshot> {
    if (!desktopStore) {
        const browserDocumentKey = legacyDocumentKey ?? sourceSha256;
        return {
            overrides: loadScanCleanupDocumentOverrides(browserDocumentKey),
            marginsMm: loadScanCleanupDocumentMargins(browserDocumentKey),
            outputMode: loadScanCleanupDocumentOutputMode(browserDocumentKey),
        };
    }
    return whenScanCleanupPreferencesReady().then(async () => {
        if (!isScanCleanupSourceSha256(sourceSha256)) {
            warnMissingDocumentSourceHash('load', legacyDocumentKey);
            return {
                overrides: {},
                marginsMm: null,
                outputMode: 'auto' as const,
            };
        }
        const normalizedSourceSha256 = sourceSha256.toLowerCase();
        if (!remoteSettingsFile?.documentOverrides[normalizedSourceSha256]) {
            try {
                remoteSettingsFile = await readRemoteSettings(createSettingsReadRequest(
                    normalizedSourceSha256,
                    legacyDocumentKey,
                ));
            } catch (error) {
                BrowserLogger.error('scan-cleanup', 'Failed to load document settings', error);
            }
        }
        const entry = remoteSettingsFile?.documentOverrides[normalizedSourceSha256];
        return {
            overrides: cloneScanCleanupPreferenceValue(entry?.overrides ?? {}),
            marginsMm: entry?.marginsMm === undefined
                ? null
                : cloneScanCleanupPreferenceValue(entry.marginsMm),
            outputMode: entry?.outputMode ?? 'auto',
        };
    });
}

export function saveScanCleanupDocumentPreferencesInStore(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    patch: IScanCleanupDocumentPreferencePatch,
) {
    if (!desktopStore) {
        saveScanCleanupDocumentPreferences(legacyDocumentKey ?? sourceSha256, patch);
        return;
    }
    if (!isScanCleanupSourceSha256(sourceSha256)) {
        warnMissingDocumentSourceHash('persist', legacyDocumentKey);
        return;
    }
    queueRemoteUpdate({document: {
        sourceSha256: sourceSha256.toLowerCase(),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
        patch: cloneScanCleanupPreferenceValue(patch),
    }});
}

export function dismissScanCleanupFirstRunGuidanceInStore() {
    getScanCleanupPreferencesStore().firstRunGuidanceDismissed = true;
}

/** Re-loads the singleton on its next access. Primarily useful for isolated tests. */
export function resetScanCleanupPreferencesStore() {
    flushScanCleanupPreferencesStore();
    persistenceScope?.stop();
    persistenceScope = null;
    unregisterLifecycleListeners();
    preferences = null;
    preferencesHydrated = false;
    preferencesHydrationPromise = null;
    remoteSettingsFile = null;
    remoteWriteQueue = Promise.resolve();
    migrationContext = {};
    desktopStore = false;
    applyingRemotePreferences = false;
    documentPersistenceEpochs.clear();
}
