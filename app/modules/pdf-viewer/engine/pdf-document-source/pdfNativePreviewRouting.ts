import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';

export const PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES = 512 * 1024 * 1024;
const STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES = 1_000;

export function isPathPdfSource(value: TPdfSource | null | undefined): value is IPdfPathSource {
    return Boolean(
        value
        && typeof value === 'object'
        && !(value instanceof Blob)
        && value.kind === 'path'
        && typeof value.path === 'string',
    );
}

export function shouldStageNativePdfOpeningPreview(
    value: TPdfSource | null | undefined,
    geometry: IPdfOpeningGeometry | null | undefined,
) {
    return Boolean(
        isPathPdfSource(value)
        && !isBrowserDocumentRef(value.path)
        && geometry
        && (
            value.size >= PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES
            || geometry.linearized === false
                && geometry.pageCount >= STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES
        ),
    );
}
