import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';
import { isBrowserDocumentRef } from '@app/utils/documentRef';

export const PDFJS_NATIVE_PREVIEW_MIN_BYTES = 512 * 1024 * 1024;

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
