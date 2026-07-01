import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentsFileIoCapability,
    IPdfNativePagePreviewOptions,
} from '@contracts/electronApiDocuments';

interface INativePdfRenderedPageObjectUrl {
    objectUrl: string;
    renderedPx: number;
}

function createPngObjectUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
}

export function createNativePdfPreviewSourceFromPath(
    pdfPath: TDocumentRef,
    documentFiles: Pick<IDocumentsFileIoCapability, 'getPdfNativePageSizes' | 'renderPdfNativePagePreview'>,
) {
    const getPdfNativePageSizes = documentFiles.getPdfNativePageSizes;
    const renderPdfNativePagePreview = documentFiles.renderPdfNativePagePreview;

    if (
        typeof getPdfNativePageSizes !== 'function'
        || typeof renderPdfNativePagePreview !== 'function'
    ) {
        throw new Error('Native PDF preview is unavailable in this runtime');
    }

    return {
        getPageSizes: () => getPdfNativePageSizes(pdfPath),
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IPdfNativePagePreviewOptions,
        ): Promise<INativePdfRenderedPageObjectUrl> {
            const preview = await renderPdfNativePagePreview(pdfPath, pageNumber, options);
            return {
                objectUrl: createPngObjectUrl(preview.bytes),
                renderedPx: preview.width,
            };
        },
        revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
        terminate() {},
    };
}
