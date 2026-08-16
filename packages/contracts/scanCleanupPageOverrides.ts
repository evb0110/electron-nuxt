import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    TScanCleanupLayoutByPage,
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
        manualSkewDegrees,
        marginsMm,
        outputModeOverride,
        placementOverrides,
        ...scalarValues
    } = value;
    return {
        ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        ...scalarValues,
        ...(manualSkewDegrees === undefined ? {} : {manualSkewDegrees}),
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
        ...(outputModeOverride ? {outputModeOverride} : {}),
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
        && value.manualSkewDegrees === undefined
        && value.outputModeOverride === undefined
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

export function resolveScanCleanupPlacementOffset(
    availableWidth: number,
    availableHeight: number,
    alignment: IScanCleanupOptions['pageAlignment'],
) {
    const [
        vertical,
        horizontal = vertical,
    ] = alignment.split('-');
    return {
        // Keep this in the geometry contract's native currency. Pixel callers
        // may quantize the result at their serialization boundary, while the
        // lossless PDF path must retain the fractional point offset.
        x: horizontal === 'left' ? 0 : horizontal === 'right' ? availableWidth : availableWidth / 2,
        y: vertical === 'top' ? 0 : vertical === 'bottom' ? availableHeight : availableHeight / 2,
    };
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

/**
 * The layouts a run is told to expect, as a plain record the bridge can carry.
 * Matched page size is measured over the pages a run produces, and this is what
 * the preview and the run are both measured against.
 */
export function toScanCleanupLayoutByPage(
    classifications: ReadonlyMap<number, IScanCleanupPreviewMetadata['layoutClassification']>,
): TScanCleanupLayoutByPage {
    const layouts: TScanCleanupLayoutByPage = {};
    for (const [
        pageNumber,
        classification,
    ] of classifications) {
        layouts[String(pageNumber)] = classification;
    }
    return layouts;
}

/**
 * Compact main-process request identity for the spread classifications a
 * matched render was asked to use.
 *
 * That is the whole of it, because a spread is the only classification the
 * matched canvas reads — every other page is measured as the whole sheet it is,
 * classified or not (see resolveScanCleanupDocumentCanvas). Classifying another
 * page as anything but a spread therefore cannot move the rectangle. Renderer
 * invalidation is deliberately keyed on the resolved canvas plan instead: on
 * a spread-majority book this set can grow hundreds of times while the actual
 * rectangle remains unchanged.
 */
export function scanCleanupLayoutSignature(layouts: TScanCleanupLayoutByPage) {
    const spreads = Object.entries(layouts)
        .filter(entry => entry[1] === 'two-page-spread')
        .map(entry => Number(entry[0]))
        .sort((left, right) => left - right);
    const ranges: string[] = [];
    for (let index = 0; index < spreads.length;) {
        const start = spreads[index]!;
        let end = start;
        while (index + 1 < spreads.length && spreads[index + 1] === end + 1) {
            index += 1;
            end = spreads[index]!;
        }
        index += 1;
        ranges.push(start === end ? String(start) : `${String(start)}-${String(end)}`);
    }
    return ranges.join(',');
}

/**
 * The rest of what a cached preview has to be revalidated against when matched
 * page size is on: the document-wide inputs the matched canvas is measured
 * from, which no single page's cache key carries.
 *
 * `resolveScanCleanupDocumentCanvas` reads the whole document to answer one
 * rectangle — which pages are produced at all (`excluded`), how many outputs
 * each sheet is cut into (`layoutOverride`, including keep-left/right, and
 * whether a `manualSplit` exists), and whether any page can be rendered in
 * continuous tone, which halves the pixel budget the grid is held inside
 * (`outputModeOverride`). Excluding page 40 therefore changes the canvas page 1
 * was drawn on, and without this the renderer would keep serving page 1 from a
 * cache measured against the old document.
 *
 * Only the non-default overrides are visited — the record holds nothing else —
 * so this is proportional to what the user has actually touched rather than to
 * the document's length, and it is derived once per settings change rather than
 * once per cache key.
 *
 * Each field is reduced to what the canvas can actually read: the split's
 * position and the exact tone of a page's output mode do not move the
 * rectangle, and keying on them would throw away every cached page of the
 * document for an edit that cannot have changed it.
 *
 * Every entry is read through `getScanCleanupPageOverride`, because the record
 * also arrives from disk and from the bridge, where a partially written entry
 * leaves a field absent rather than at its default. The canvas resolves those
 * entries the same way, so a signature taken off the raw record would distinguish
 * two documents the canvas cannot tell apart and drop the whole preview cache.
 */
export function scanCleanupMatchedCanvasOverridesSignature(overrides: TScanCleanupPageOverrides) {
    return Object.keys(overrides)
        .map(pageKey => {
            const override = getScanCleanupPageOverride(overrides, Number(pageKey));
            const canvasInputs = [
                override.excluded ? 'excluded' : '',
                override.layoutOverride,
                override.manualSplit ? 'split' : '',
                // Only whether the page can leave the bilevel pixel budget.
                override.outputModeOverride === undefined
                    ? ''
                    : override.outputModeOverride === 'bw' ? 'bw' : 'tonal',
            ].join(':');
            return canvasInputs === ':auto::' ? '' : `${pageKey}=${canvasInputs}`;
        })
        .filter(entry => entry !== '')
        .sort()
        .join(',');
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
