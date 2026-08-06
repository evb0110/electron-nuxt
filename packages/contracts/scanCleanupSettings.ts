import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/geometry';
import {SCAN_CLEANUP_MARGIN_MAX_MM} from '@contracts/scan-cleanup/geometry';
import type {
    IScanCleanupOptions,
    TScanCleanupBinarizationMethod,
    TScanCleanupDespeckleLevel,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
} from '@contracts/scan-cleanup/domain';
import {isRecord} from '@contracts/runtimeGuards';
import {
    decodeScanCleanupPageOverrides,
    SCAN_CLEANUP_IPC_PATH_LENGTH_MAX,
} from '@contracts/scan-cleanup/ipcRequestCodecs';

export const SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION = 1 as const;
export const SCAN_CLEANUP_SETTINGS_FILE_NAME = 'scan-cleanup-settings.json';
export const SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES = 50;
const SCAN_CLEANUP_LEGACY_STORAGE_STRING_MAX = 4 * 1024 * 1024;

export interface IScanCleanupGlobalPreferences extends Omit<
    IScanCleanupOptions,
    'autoDewarp' | 'autoDewarpDepth' | 'binarization' | 'despeckle' | 'despeckleLevel' | 'normalizeIllumination' | 'outputMode' | 'pageOverrides'
> {
    autoDewarp: boolean;
    autoDewarpDepth: number | undefined;
    binarization: TScanCleanupBinarizationMethod;
    despeckleLevel: TScanCleanupDespeckleLevel;
    normalizeIllumination: boolean;
    firstRunGuidanceDismissed: boolean;
}

export const DEFAULT_SCAN_CLEANUP_PREFERENCES: Readonly<IScanCleanupGlobalPreferences> = Object.freeze({
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: Object.freeze({
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    }),
    despeckleLevel: 'normal',
    autoDewarp: false,
    autoDewarpDepth: undefined,
    skipBlankPages: false,
    firstRunGuidanceDismissed: false,
});

export interface IScanCleanupDocumentOverrideEntry {
    overrides?: TScanCleanupPageOverrides;
    marginsMm?: IScanCleanupMarginsMm;
    outputMode?: TScanCleanupOutputModeSetting;
    lastUsedAtMs: number;
}

export interface IScanCleanupSettingsFile {
    schemaVersion: typeof SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION;
    settings: IScanCleanupGlobalPreferences;
    documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry>;
}

/**
 * Renderer-side export of the old origin-scoped storage. The main process
 * intentionally receives values only; it never reaches into renderer storage.
 */
export interface IScanCleanupLegacyStorageExport {
    settingsRaw: string | null;
    documentOverridesRaw: string | null;
    exportedAtMs?: number;
}

export interface IScanCleanupSettingsReadRequest {
    legacyStorage?: IScanCleanupLegacyStorageExport;
    sourceSha256?: string | null;
    legacyDocumentKey?: string | null;
}

export interface IScanCleanupDocumentPreferencePatch {
    overrides?: TScanCleanupPageOverrides;
    marginsMm?: IScanCleanupMarginsMm;
    outputMode?: TScanCleanupOutputModeSetting;
    resetOverrides?: boolean;
}

export interface IScanCleanupSettingsUpdateRequest {
    settings?: IScanCleanupGlobalPreferences;
    document?: {
        sourceSha256: string;
        legacyDocumentKey?: string | null;
        patch: IScanCleanupDocumentPreferencePatch;
    };
}

function decodeNullableString(
    value: unknown,
    label: string,
    maxLength = SCAN_CLEANUP_IPC_PATH_LENGTH_MAX,
): string | null | undefined {
    if (
        value === undefined
        || value === null
        || typeof value === 'string' && value.length <= maxLength
    ) {
        return value;
    }
    throw new Error(`Invalid scan-cleanup settings ${label}`);
}

function decodeLegacyStorageExport(value: unknown): IScanCleanupLegacyStorageExport {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored || (stored.settingsRaw !== null && typeof stored.settingsRaw !== 'string')
        || (stored.documentOverridesRaw !== null && typeof stored.documentOverridesRaw !== 'string')
        || (typeof stored.settingsRaw === 'string'
            && stored.settingsRaw.length > SCAN_CLEANUP_LEGACY_STORAGE_STRING_MAX)
        || (typeof stored.documentOverridesRaw === 'string'
            && stored.documentOverridesRaw.length > SCAN_CLEANUP_LEGACY_STORAGE_STRING_MAX)
        || (stored.exportedAtMs !== undefined
            && (typeof stored.exportedAtMs !== 'number' || !Number.isFinite(stored.exportedAtMs)))) {
        throw new Error('Invalid scan-cleanup legacy storage export');
    }
    return {
        settingsRaw: stored.settingsRaw,
        documentOverridesRaw: stored.documentOverridesRaw,
        ...(stored.exportedAtMs === undefined ? {} : {exportedAtMs: stored.exportedAtMs}),
    };
}

export function decodeScanCleanupSettingsReadRequest(value: unknown): IScanCleanupSettingsReadRequest {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings read request');
    }
    const sourceSha256 = stored.sourceSha256 === undefined
        ? undefined
        : decodeNullableString(stored.sourceSha256, 'source hash');
    const legacyDocumentKey = stored.legacyDocumentKey === undefined
        ? undefined
        : decodeNullableString(stored.legacyDocumentKey, 'legacy document key');
    return {
        ...(stored.legacyStorage === undefined ? {} : {legacyStorage: decodeLegacyStorageExport(stored.legacyStorage)}),
        ...(sourceSha256 === undefined ? {} : {sourceSha256}),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
    };
}

function decodeDocumentPatch(value: unknown): IScanCleanupDocumentPreferencePatch {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup document settings patch');
    }
    const outputMode = decodeOutputMode(stored.outputMode);
    if (stored.outputMode !== undefined && outputMode === undefined) {
        throw new Error('Invalid scan-cleanup document output mode');
    }
    if (stored.resetOverrides !== undefined && typeof stored.resetOverrides !== 'boolean') {
        throw new Error('Invalid scan-cleanup document reset flag');
    }
    const marginsMm = stored.marginsMm === undefined
        ? undefined
        : decodeScanCleanupMarginsMm(stored.marginsMm);
    const overrides = stored.overrides === undefined
        ? undefined
        : decodeScanCleanupPageOverrides(stored.overrides);
    return {
        ...(overrides === undefined || overrides === null ? {} : {overrides}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        ...(stored.resetOverrides === undefined ? {} : {resetOverrides: stored.resetOverrides}),
    };
}

export function decodeScanCleanupSettingsUpdateRequest(value: unknown): IScanCleanupSettingsUpdateRequest {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings update request');
    }
    const settings = stored.settings === undefined
        ? undefined
        : decodeScanCleanupGlobalPreferences(stored.settings);
    if (stored.document === undefined) {
        return settings === undefined ? {} : {settings};
    }
    const documentValue = scanCleanupPreferenceRecord(stored.document);
    if (!documentValue) {
        throw new Error('Invalid scan-cleanup document settings update');
    }
    const sourceSha256 = documentValue.sourceSha256;
    if (!isScanCleanupSourceSha256(sourceSha256)) {
        throw new Error('Scan-cleanup document settings require a SHA-256 source key');
    }
    const legacyDocumentKey = documentValue.legacyDocumentKey === undefined
        ? undefined
        : decodeNullableString(documentValue.legacyDocumentKey, 'legacy document key');
    return {
        ...(settings === undefined ? {} : {settings}),
        document: {
            sourceSha256: sourceSha256.toLowerCase(),
            ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
            patch: decodeDocumentPatch(documentValue.patch),
        },
    };
}

export function scanCleanupPreferenceRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

export function parseScanCleanupPreferenceJson(raw: string | null | undefined) {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

export function cloneScanCleanupPreferenceValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function clampScanCleanupMargin(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(SCAN_CLEANUP_MARGIN_MAX_MM, Math.max(0, value))
        : fallback;
}

export function decodeScanCleanupMarginsMm(
    value: unknown,
    fallback: IScanCleanupMarginsMm = DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm,
): IScanCleanupMarginsMm {
    const stored = scanCleanupPreferenceRecord(value);
    return {
        leftMm: clampScanCleanupMargin(stored?.leftMm, fallback.leftMm),
        topMm: clampScanCleanupMargin(stored?.topMm, fallback.topMm),
        rightMm: clampScanCleanupMargin(stored?.rightMm, fallback.rightMm),
        bottomMm: clampScanCleanupMargin(stored?.bottomMm, fallback.bottomMm),
    };
}

export function decodeScanCleanupGlobalPreferences(value: unknown): IScanCleanupGlobalPreferences {
    const stored = scanCleanupPreferenceRecord(value);
    const defaults = DEFAULT_SCAN_CLEANUP_PREFERENCES;
    if (!stored) {
        return cloneScanCleanupPreferenceValue(defaults);
    }
    const legacyMarginMm = typeof stored.marginMm === 'number' && Number.isFinite(stored.marginMm)
        ? Math.min(SCAN_CLEANUP_MARGIN_MAX_MM, Math.max(0, stored.marginMm))
        : null;
    const legacyMargins = legacyMarginMm === null
        ? defaults.marginsMm
        : {
            leftMm: legacyMarginMm,
            topMm: legacyMarginMm,
            rightMm: legacyMarginMm,
            bottomMm: legacyMarginMm,
        };
    return {
        preserveOriginalQuality: typeof stored.preserveOriginalQuality === 'boolean'
            ? stored.preserveOriginalQuality
            : defaults.preserveOriginalQuality,
        layoutMode: [
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(stored.layoutMode))
            ? stored.layoutMode as IScanCleanupGlobalPreferences['layoutMode']
            : defaults.layoutMode,
        binarization: [
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].includes(String(stored.binarization))
            ? stored.binarization as TScanCleanupBinarizationMethod
            : defaults.binarization,
        normalizeIllumination: typeof stored.normalizeIllumination === 'boolean'
            ? stored.normalizeIllumination
            : defaults.normalizeIllumination,
        readingOrder: stored.readingOrder === 'rtl' ? 'rtl' : 'ltr',
        thickness: typeof stored.thickness === 'number' && Number.isFinite(stored.thickness)
            ? Math.min(5, Math.max(-5, stored.thickness))
            : defaults.thickness,
        crop: typeof stored.crop === 'boolean' ? stored.crop : defaults.crop,
        matchPageSize: typeof stored.matchPageSize === 'boolean' ? stored.matchPageSize : defaults.matchPageSize,
        pageAlignment: typeof stored.pageAlignment === 'string' && [
            'top-left',
            'top-center',
            'top-right',
            'center-left',
            'center',
            'center-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ].includes(stored.pageAlignment)
            ? stored.pageAlignment as IScanCleanupGlobalPreferences['pageAlignment']
            : defaults.pageAlignment,
        marginsMm: decodeScanCleanupMarginsMm(stored.marginsMm, legacyMargins),
        despeckleLevel: [
            'off',
            'cautious',
            'normal',
            'aggressive',
        ].includes(String(stored.despeckleLevel))
            ? stored.despeckleLevel as TScanCleanupDespeckleLevel
            : typeof stored.despeckle === 'boolean'
                ? stored.despeckle ? 'normal' : 'off'
                : defaults.despeckleLevel,
        autoDewarp: typeof stored.autoDewarp === 'boolean' ? stored.autoDewarp : defaults.autoDewarp,
        autoDewarpDepth: typeof stored.autoDewarpDepth === 'number'
            && Number.isFinite(stored.autoDewarpDepth)
            && stored.autoDewarpDepth >= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
            && stored.autoDewarpDepth <= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
            ? stored.autoDewarpDepth
            : defaults.autoDewarpDepth,
        skipBlankPages: typeof stored.skipBlankPages === 'boolean' ? stored.skipBlankPages : defaults.skipBlankPages,
        firstRunGuidanceDismissed: typeof stored.firstRunGuidanceDismissed === 'boolean'
            ? stored.firstRunGuidanceDismissed
            : defaults.firstRunGuidanceDismissed,
    };
}

export function assertFiniteScanCleanupPreferences(value: IScanCleanupGlobalPreferences) {
    if (
        !Number.isFinite(value.thickness)
        || (value.autoDewarpDepth !== undefined && !Number.isFinite(value.autoDewarpDepth))
        || Object.values(value.marginsMm).some(margin => !Number.isFinite(margin))
    ) {
        throw new TypeError('Scan cleanup preferences require finite numeric values');
    }
}

function decodeOutputMode(value: unknown): TScanCleanupOutputModeSetting | undefined {
    return [
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(value))
        ? value as TScanCleanupOutputModeSetting
        : undefined;
}

function decodeDocumentOverrideEntry(value: unknown): IScanCleanupDocumentOverrideEntry | null {
    const stored = scanCleanupPreferenceRecord(value);
    const lastUsedAtMs = stored?.lastUsedAtMs;
    if (typeof lastUsedAtMs !== 'number' || !Number.isFinite(lastUsedAtMs) || lastUsedAtMs < 0) {
        return null;
    }
    const outputMode = decodeOutputMode(stored?.outputMode);
    const marginsMm = stored?.marginsMm === undefined
        ? undefined
        : decodeScanCleanupMarginsMm(stored.marginsMm);
    const overrides = scanCleanupPreferenceRecord(stored?.overrides) as TScanCleanupPageOverrides | null;
    if (stored?.overrides !== undefined && overrides === null) {
        return null;
    }
    return {
        ...(overrides === null ? {} : {overrides}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        lastUsedAtMs,
    };
}

export function isScanCleanupSourceSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value);
}

export function decodeScanCleanupSettingsFile(value: unknown): IScanCleanupSettingsFile {
    const stored = scanCleanupPreferenceRecord(value);
    if (stored?.schemaVersion !== SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION) {
        throw new Error(`Unsupported scan-cleanup settings schema version: ${String(stored?.schemaVersion ?? 'missing')}`);
    }
    const storedOverrides = scanCleanupPreferenceRecord(stored.documentOverrides);
    if (!storedOverrides) {
        throw new Error('Invalid scan-cleanup settings documentOverrides');
    }
    const documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry> = {};
    for (const [
        key,
        entry,
    ] of Object.entries(storedOverrides)) {
        if (!isScanCleanupSourceSha256(key)) {
            continue;
        }
        const decoded = decodeDocumentOverrideEntry(entry);
        if (decoded) {
            documentOverrides[key.toLowerCase()] = decoded;
        }
    }
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: decodeScanCleanupGlobalPreferences(stored.settings),
        documentOverrides,
    };
}

export function createDefaultScanCleanupSettingsFile(): IScanCleanupSettingsFile {
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: cloneScanCleanupPreferenceValue(DEFAULT_SCAN_CLEANUP_PREFERENCES),
        documentOverrides: {},
    };
}
