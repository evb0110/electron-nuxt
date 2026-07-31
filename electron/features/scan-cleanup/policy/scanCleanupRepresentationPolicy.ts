import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import type {IDetectedPageRaster} from '@electron/pdf/sourceDpiDetection';

/**
 * A compact MRC/JBIG2 scan is already an optimized representation. Automatic
 * cleanup may spend some bytes on pages it materially changes, but it must not
 * silently flatten the whole book into full-resolution continuous-tone images.
 */
export const SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO = 2.5;
export const SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE = 8 * 1024 * 1024;
const COMPACT_SOURCE_PAGE_MAJORITY = 0.5;

export interface IScanCleanupCompactSourceBudget {
    compactLayeredPages: number;
    maxOutputBytes: number;
    sourceBytes: number;
}

function isCompactLayeredRaster(raster: IDetectedPageRaster | undefined) {
    return raster?.hasBilevelLayer === true
        && raster.backgroundDpi !== undefined
        && Number.isFinite(raster.backgroundDpi)
        && raster.backgroundDpi > 0;
}

export function resolveScanCleanupCompactSourceBudget(input: {
    documentPageCount: number;
    options: IScanCleanupOptions;
    pageRasterByNumber: ReadonlyMap<number, IDetectedPageRaster>;
    partialRun: boolean;
    sourceBytes: number;
}): IScanCleanupCompactSourceBudget | null {
    if (
        input.partialRun
        || input.options.outputMode !== 'auto'
        || !Number.isFinite(input.sourceBytes)
        || input.sourceBytes <= 0
        || Object.values(input.options.pageOverrides).some(
            pageOverride => pageOverride.outputModeOverride !== undefined,
        )
    ) {
        return null;
    }
    const compactLayeredPages = Array.from(
        {length: input.documentPageCount},
        (_, index) => index + 1,
    ).filter(pageNumber => isCompactLayeredRaster(
        input.pageRasterByNumber.get(pageNumber),
    )).length;
    if (
        compactLayeredPages === 0
        || compactLayeredPages / input.documentPageCount < COMPACT_SOURCE_PAGE_MAJORITY
    ) {
        return null;
    }
    return {
        compactLayeredPages,
        sourceBytes: input.sourceBytes,
        maxOutputBytes: Math.ceil(Math.max(
            input.sourceBytes * SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO,
            input.sourceBytes + SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE,
        )),
    };
}

export function assertScanCleanupCompactSourceBudget(
    outputBytes: number,
    budget: IScanCleanupCompactSourceBudget | null,
) {
    if (budget === null || outputBytes <= budget.maxOutputBytes) {
        return;
    }
    throw new Error(
        'Automatic scan cleanup refused to publish a compact layered source '
        + `that expanded from ${String(budget.sourceBytes)} to ${String(outputBytes)} bytes `
        + `(budget ${String(budget.maxOutputBytes)} bytes)`,
    );
}
