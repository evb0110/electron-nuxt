import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';

export const PDFJS_NATIVE_PREVIEW_MIN_BYTES = 512 * 1024 * 1024;
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

export function shouldUseNativePdfPreview(value: TPdfSource | null | undefined) {
    return Boolean(
        isPathPdfSource(value)
        && !isBrowserDocumentRef(value.path)
        && Number.isFinite(value.size)
        && value.size >= PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    );
}

export function shouldStageNativePdfOpeningPreview(
    value: TPdfSource | null | undefined,
    geometry: IPdfOpeningGeometry | null | undefined,
) {
    return Boolean(
        isPathPdfSource(value)
        && !isBrowserDocumentRef(value.path)
        && value.size < PDFJS_NATIVE_PREVIEW_MIN_BYTES
        && geometry?.linearized === false
        && geometry.pageCount >= STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES,
    );
}
