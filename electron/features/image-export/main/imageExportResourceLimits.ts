import { stat } from 'fs/promises';
import { clampDpi } from '@electron/image/imageDpi';

const IMAGE_EXPORT_MAX_PAGE_FILE_BYTES = 512 * 1024 * 1024;
const IMAGE_EXPORT_MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;
const POINTS_PER_INCH = 72;
const DEFAULT_EXPORT_RENDER_DPI = 300;
const PPM_HEADER_AND_ROUNDING_RESERVE_BYTES = 64 * 1024;

export const IMAGE_EXPORT_MAX_NETPBM_READ_BYTES = 192 * 1024 * 1024;

const IMAGE_EXPORT_MAX_RENDER_DIMENSION = Math.floor(
    Math.sqrt((IMAGE_EXPORT_MAX_NETPBM_READ_BYTES - PPM_HEADER_AND_ROUNDING_RESERVE_BYTES) / 3),
);

export interface IExportPageSize {
    widthPts: number;
    heightPts: number;
}

export function resolveExportRenderDpi(detectedDpi: number | null, pageSizes: readonly IExportPageSize[]) {
    const requestedDpi = clampDpi(detectedDpi ?? DEFAULT_EXPORT_RENDER_DPI);
    let longestSidePts = 0;
    for (const pageSize of pageSizes) {
        longestSidePts = Math.max(longestSidePts, pageSize.widthPts, pageSize.heightPts);
    }

    if (longestSidePts <= 0) {
        return requestedDpi;
    }

    const dimensionLimitedDpi = Math.floor((IMAGE_EXPORT_MAX_RENDER_DIMENSION * POINTS_PER_INCH) / longestSidePts);
    return Math.max(1, Math.min(requestedDpi, dimensionLimitedDpi));
}

export async function validateRenderedImagePageFiles(pageFiles: Array<{
    page: number;
    path: string;
}>) {
    let renderedBytes = 0;
    for (const pageFile of pageFiles) {
        const fileStat = await stat(pageFile.path);
        if (fileStat.size > IMAGE_EXPORT_MAX_PAGE_FILE_BYTES) {
            throw new RangeError(`Rendered page ${pageFile.page} exceeds the 512 MiB file limit`);
        }
        renderedBytes += fileStat.size;
        if (renderedBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
            throw new RangeError('Rendered image chunk exceeds the 2 GiB scratch limit');
        }
    }
}

export async function addStagedImageFileBytes(
    currentBytes: number,
    path: string,
    errorMessage: string,
) {
    const nextBytes = currentBytes + (await stat(path)).size;
    if (nextBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
        throw new RangeError(errorMessage);
    }
    return nextBytes;
}
