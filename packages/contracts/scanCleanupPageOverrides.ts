import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';

export type TScanCleanupResolvedPageLayout = ReturnType<typeof resolveScanCleanupPageLayout>;

export const DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE: Readonly<IScanCleanupPageOverride> = Object.freeze({
    rotation: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplitX: null,
});

export function createScanCleanupPageOverride(
    value: Partial<IScanCleanupPageOverride> = {},
): IScanCleanupPageOverride {
    return {
        ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        ...value,
    };
}

export function getScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: number,
): IScanCleanupPageOverride {
    return createScanCleanupPageOverride(overrides[String(pageNumber)]);
}

export function setScanCleanupPageOverride(
    overrides: TScanCleanupPageOverrides,
    pageNumber: number,
    value: IScanCleanupPageOverride,
) {
    const key = String(pageNumber);
    if (isDefaultScanCleanupPageOverride(value)) {
        Reflect.deleteProperty(overrides, key);
        return;
    }
    overrides[key] = createScanCleanupPageOverride(value);
}

export function isDefaultScanCleanupPageOverride(value: IScanCleanupPageOverride) {
    return value.rotation === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotation
        && value.layoutOverride === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride
        && value.excluded === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded
        && value.manualSplitX === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.manualSplitX;
}

export function resolveScanCleanupPageLayout(
    layoutMode: IScanCleanupOptions['layoutMode'],
    override: TScanCleanupPageLayoutOverride,
) {
    if (override === 'single') {
        return 'force-single' as const;
    }
    if (override === 'spread') {
        return 'force-two-page' as const;
    }
    if (override === 'keep-left' || override === 'keep-right') {
        return override;
    }
    return layoutMode;
}

function automaticOutputCount(
    classification: IScanCleanupPreviewMetadata['layoutClassification'] | undefined,
) {
    return classification === 'two-page-spread' ? 2 : 1;
}

export function estimateScanCleanupOutputPages(
    totalPages: number,
    options: Pick<IScanCleanupOptions, 'layoutMode' | 'pageOverrides'>
        & Partial<Pick<IScanCleanupOptions, 'skipBlankPages'>>,
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
) {
    let outputPages = 0;
    let exact = options.skipBlankPages !== true;
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        const pageOverride = getScanCleanupPageOverride(options.pageOverrides, pageNumber);
        if (pageOverride.excluded) continue;
        const layout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
        if (layout === 'force-two-page') {
            outputPages += 2;
        } else if (layout === 'force-single' || layout === 'keep-left' || layout === 'keep-right') {
            outputPages += 1;
        } else {
            const classification = classifications.get(pageNumber);
            if (classification === undefined) exact = false;
            outputPages += automaticOutputCount(classification);
        }
    }
    return {
        exact,
        outputPages,
    };
}
