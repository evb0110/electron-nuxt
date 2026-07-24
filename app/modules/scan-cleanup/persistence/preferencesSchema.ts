import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    TScanCleanupBinarizationMethod,
    TScanCleanupDespeckleLevel,
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_MARGIN_MAX_MM,
} from '@contracts/electronApiScanCleanup';

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

export function scanCleanupPreferenceRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function parseScanCleanupPreferenceJson(raw: string | null) {
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
    // Legacy scalar preferences are the only supported migration path for the retired key.
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
            : defaults.preserveOriginalQuality ?? false,
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
