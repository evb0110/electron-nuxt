import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';

export type TScanCleanupResolvedPageLayout = ReturnType<typeof resolveScanCleanupPageLayout>;

export const DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE: Readonly<IScanCleanupPageOverride> = Object.freeze({
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
});

export function createScanCleanupPageOverride(
    value: Partial<IScanCleanupPageOverride> = {},
    documentMargins?: IScanCleanupMarginsMm,
): IScanCleanupPageOverride {
    const {
        manualContentBoxes,
        manualZones,
        marginsMm,
        placementOverrides,
        ...scalarValues
    } = value;
    return {
        ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        ...scalarValues,
        ...(manualContentBoxes ? {manualContentBoxes: {...manualContentBoxes}} : {}),
        ...(manualZones ? {manualZones: {
            picture: manualZones.picture.map(zone => ({
                layer: zone.layer,
                polygon: {
                    points: zone.polygon.points.map(point => ({...point})),
                    rotationDegrees: zone.polygon.rotationDegrees,
                },
            })),
            fill: manualZones.fill.map(polygon => ({
                points: polygon.points.map(point => ({...point})),
                rotationDegrees: polygon.rotationDegrees,
            })),
        }} : {}),
        ...(marginsMm && (!documentMargins || !areScanCleanupMarginsMmEqual(marginsMm, documentMargins))
            ? {marginsMm: {...marginsMm}}
            : {}),
        ...(placementOverrides ? {placementOverrides: {...placementOverrides}} : {}),
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
    documentMargins?: IScanCleanupMarginsMm,
) {
    const key = String(pageNumber);
    const normalized = createScanCleanupPageOverride(value, documentMargins);
    if (isDefaultScanCleanupPageOverride(normalized)) {
        Reflect.deleteProperty(overrides, key);
        return;
    }
    overrides[key] = normalized;
}

export function isDefaultScanCleanupPageOverride(value: IScanCleanupPageOverride) {
    return value.rotationDegrees === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees
        && value.layoutOverride === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride
        && value.excluded === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded
        && value.manualSplit === DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.manualSplit
        && Object.keys(value.manualContentBoxes ?? {}).length === 0
        && (value.manualZones?.picture.length ?? 0) === 0
        && (value.manualZones?.fill.length ?? 0) === 0
        && value.marginsMm === undefined
        && Object.keys(value.placementOverrides ?? {}).length === 0;
}

export function areScanCleanupMarginsMmEqual(
    left: IScanCleanupMarginsMm,
    right: IScanCleanupMarginsMm,
) {
    return left.leftMm === right.leftMm
        && left.topMm === right.topMm
        && left.rightMm === right.rightMm
        && left.bottomMm === right.bottomMm;
}

export function resolveScanCleanupMarginsMm(
    documentMargins: IScanCleanupMarginsMm,
    override: Pick<IScanCleanupPageOverride, 'marginsMm'>,
) {
    return override.marginsMm ?? documentMargins;
}

export function resolveScanCleanupOutputPlacement(
    documentDefault: IScanCleanupOptions['pageAlignment'],
    override: Pick<IScanCleanupPageOverride, 'placementOverrides'>,
    half: IScanCleanupPreviewMetadata['half'],
) {
    return override.placementOverrides?.[half] ?? documentDefault;
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

export function shouldShowScanCleanupOutputEstimate(
    totalPages: number,
    options: Pick<IScanCleanupOptions, 'layoutMode' | 'pageOverrides'>
        & Partial<Pick<IScanCleanupOptions, 'skipBlankPages'>>,
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
) {
    if (classifications.size > 0 || options.layoutMode !== 'auto') {
        return true;
    }
    return estimateScanCleanupOutputPages(totalPages, options, classifications).exact;
}
