import { stat } from 'fs/promises';

export const IMAGE_EXPORT_MAX_RENDER_DIMENSION = 8_192;
const IMAGE_EXPORT_MAX_PAGE_FILE_BYTES = 512 * 1024 * 1024;
const IMAGE_EXPORT_MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;

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
