import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {
    cloneScanCleanupPreferenceValue,
    DEFAULT_SCAN_CLEANUP_PREFERENCES,
} from '@contracts/scanCleanupSettings';

export type TScanCleanupNonDefaultSettingKey =
    | 'preserveOriginalQuality'
    | 'layoutMode'
    | 'binarization'
    | 'normalizeIllumination'
    | 'readingOrder'
    | 'thickness'
    | 'crop'
    | 'matchPageSize'
    | 'pageAlignment'
    | 'marginsMm'
    | 'despeckleLevel'
    | 'autoDewarp'
    | 'skipBlankPages'
    | 'outputMode'
    | 'pageOverrides';

export interface IScanCleanupSettingsBadge {
    key: TScanCleanupNonDefaultSettingKey;
    value: string;
}

function marginsEqual(left: IScanCleanupOptions['marginsMm'], right: IScanCleanupOptions['marginsMm']) {
    return left.leftMm === right.leftMm
        && left.topMm === right.topMm
        && left.rightMm === right.rightMm
        && left.bottomMm === right.bottomMm;
}

function addBadge(
    badges: IScanCleanupSettingsBadge[],
    key: TScanCleanupNonDefaultSettingKey,
    value: string,
) {
    badges.push({
        key,
        value,
    });
}

export function resolveScanCleanupNonDefaultSettings(
    options: IScanCleanupOptions,
): IScanCleanupSettingsBadge[] {
    const defaults = DEFAULT_SCAN_CLEANUP_PREFERENCES;
    const badges: IScanCleanupSettingsBadge[] = [];
    if (options.preserveOriginalQuality !== defaults.preserveOriginalQuality) {
        addBadge(badges, 'preserveOriginalQuality', String(options.preserveOriginalQuality));
    }
    if (options.layoutMode !== defaults.layoutMode) {
        addBadge(badges, 'layoutMode', options.layoutMode);
    }
    if (options.binarization !== defaults.binarization) {
        addBadge(badges, 'binarization', options.binarization ?? 'auto');
    }
    if (options.normalizeIllumination !== defaults.normalizeIllumination) {
        addBadge(badges, 'normalizeIllumination', String(options.normalizeIllumination));
    }
    if (options.readingOrder !== defaults.readingOrder) {
        addBadge(badges, 'readingOrder', options.readingOrder);
    }
    if (options.thickness !== defaults.thickness) {
        addBadge(badges, 'thickness', String(options.thickness));
    }
    if (options.crop !== defaults.crop) {
        addBadge(badges, 'crop', String(options.crop));
    }
    if (options.matchPageSize !== defaults.matchPageSize) {
        addBadge(badges, 'matchPageSize', String(options.matchPageSize));
    }
    if (options.pageAlignment !== defaults.pageAlignment) {
        addBadge(badges, 'pageAlignment', options.pageAlignment);
    }
    if (!marginsEqual(options.marginsMm, defaults.marginsMm)) {
        addBadge(badges, 'marginsMm', JSON.stringify(options.marginsMm));
    }
    if (options.despeckleLevel !== defaults.despeckleLevel) {
        addBadge(badges, 'despeckleLevel', options.despeckleLevel ?? 'normal');
    }
    if (
        options.autoDewarp !== defaults.autoDewarp
        || options.autoDewarpDepth !== defaults.autoDewarpDepth
    ) {
        addBadge(badges, 'autoDewarp', options.autoDewarp ? 'enabled' : 'disabled');
    }
    if (options.skipBlankPages !== defaults.skipBlankPages) {
        addBadge(badges, 'skipBlankPages', String(options.skipBlankPages));
    }
    if (options.outputMode !== 'auto') {
        addBadge(badges, 'outputMode', options.outputMode);
    }
    if (Object.keys(options.pageOverrides).length > 0) {
        addBadge(badges, 'pageOverrides', String(Object.keys(options.pageOverrides).length));
    }
    return badges;
}

export function resetScanCleanupOptionsToDefaults(options: IScanCleanupOptions) {
    const defaults = cloneScanCleanupPreferenceValue(DEFAULT_SCAN_CLEANUP_PREFERENCES);
    Object.assign(options, defaults, {
        outputMode: 'auto' as const,
        pageOverrides: {},
    });
    options.autoDewarpDepth = DEFAULT_SCAN_CLEANUP_PREFERENCES.autoDewarpDepth;
    options.marginsMm = cloneScanCleanupPreferenceValue(defaults.marginsMm);
}
