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
    documentFiles: Pick<
        IDocumentsFileIoCapability,
        'cancelPdfNativePagePreview' | 'getPdfNativePageSizes' | 'renderPdfNativePagePreview'
    >,
) {
    const cancelPdfNativePagePreview = documentFiles.cancelPdfNativePagePreview;
    const getPdfNativePageSizes = documentFiles.getPdfNativePageSizes;
    const renderPdfNativePagePreview = documentFiles.renderPdfNativePagePreview;

    if (
        typeof cancelPdfNativePagePreview !== 'function'
        || typeof getPdfNativePageSizes !== 'function'
        || typeof renderPdfNativePagePreview !== 'function'
    ) {
        throw new Error('Native PDF preview is unavailable in this runtime');
    }

    let terminated = false;
    let nextPreviewRequestId = 0;
    const activePreviewRequestIds = new Set<string>();
    const activePreviewRequestIdsByPage = new Map<number, string>();
    const cancelPreviewRequest = (requestId: string) => {
        void cancelPdfNativePagePreview(requestId).catch(() => undefined);
    };
    const cancelPagePreview = (pageNumber: number) => {
        const requestId = activePreviewRequestIdsByPage.get(pageNumber);
        if (!requestId) {
            return;
        }
        activePreviewRequestIds.delete(requestId);
        activePreviewRequestIdsByPage.delete(pageNumber);
        cancelPreviewRequest(requestId);
    };
    const createPreviewRequestId = (pageNumber: number, options?: IPdfNativePagePreviewOptions) => {
        const requestId = options?.previewRequestId?.trim();
        if (requestId) {
            return requestId;
        }
        nextPreviewRequestId += 1;
        return `pdf-native-preview:${pageNumber}:${nextPreviewRequestId}`;
    };

    return {
        cancelPagePreview,
        getPageSizes: () => getPdfNativePageSizes(pdfPath),
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IPdfNativePagePreviewOptions,
        ): Promise<INativePdfRenderedPageObjectUrl> {
            if (terminated) {
                throw new Error('Native PDF preview canceled');
            }
            const previewRequestId = createPreviewRequestId(pageNumber, options);
            const previousRequestId = activePreviewRequestIdsByPage.get(pageNumber);
            if (previousRequestId && previousRequestId !== previewRequestId) {
                cancelPagePreview(pageNumber);
            }
            activePreviewRequestIds.add(previewRequestId);
            activePreviewRequestIdsByPage.set(pageNumber, previewRequestId);
            let preview;
            try {
                preview = await renderPdfNativePagePreview(pdfPath, pageNumber, {
                    ...options,
                    previewRequestId,
                });
            } finally {
                activePreviewRequestIds.delete(previewRequestId);
                if (activePreviewRequestIdsByPage.get(pageNumber) === previewRequestId) {
                    activePreviewRequestIdsByPage.delete(pageNumber);
                }
            }
            if (terminated) {
                throw new Error('Native PDF preview canceled');
            }
            return {
                objectUrl: createPngObjectUrl(preview.bytes),
                renderedPx: preview.width,
            };
        },
        revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
        terminate() {
            terminated = true;
            for (const requestId of activePreviewRequestIds) {
                cancelPreviewRequest(requestId);
            }
            activePreviewRequestIds.clear();
            activePreviewRequestIdsByPage.clear();
        },
    };
}
