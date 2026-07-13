import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentsFileIoCapability,
    IPdfNativePagePreviewOptions,
} from '@contracts/electronApiDocuments';
import {
    requireWorkspaceSurfaceBudgetPort,
    type IWorkspaceSurfaceBudgetLeasePort,
} from '@app/utils/document-viewer/workspaceSurfaceBudgetPort';

interface INativePdfRenderedPageObjectUrl {
    objectUrl: string;
    renderedPx: number;
    onInvalidated?: (listener: () => void) => () => void;
    promotePriority?: (priority: number) => void;
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
    const objectUrlLeases = new Map<string, {
        lease: IWorkspaceSurfaceBudgetLeasePort | null;
        invalidationListeners: Set<() => void>;
    }>();
    const surfaceScopeId = `native-preview:${pdfPath}`;
    const surfaceBudget = requireWorkspaceSurfaceBudgetPort();
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
            const objectUrl = createPngObjectUrl(preview.bytes);
            const leaseEntry = {
                lease: null as IWorkspaceSurfaceBudgetLeasePort | null,
                invalidationListeners: new Set<() => void>(),
            };
            objectUrlLeases.set(objectUrl, leaseEntry);
            leaseEntry.lease = surfaceBudget.reserve({
                scopeId: surfaceScopeId,
                category: 'native-preview',
                bytes: preview.width * preview.height * 4,
                priority: 20,
                evict: () => {
                    objectUrlLeases.delete(objectUrl);
                    for (const listener of leaseEntry.invalidationListeners) {
                        listener();
                    }
                    leaseEntry.invalidationListeners.clear();
                    URL.revokeObjectURL(objectUrl);
                },
            });
            if (!objectUrlLeases.has(objectUrl)) {
                leaseEntry.lease.release();
                throw new Error('Native PDF preview evicted under memory pressure');
            }
            return {
                objectUrl,
                renderedPx: preview.width,
                promotePriority(priority) {
                    leaseEntry.lease?.promotePriority?.(priority);
                },
                onInvalidated(listener: () => void) {
                    leaseEntry.invalidationListeners.add(listener);
                    return () => leaseEntry.invalidationListeners.delete(listener);
                },
            };
        },
        revokeObjectURL: (url: string) => {
            objectUrlLeases.get(url)?.lease?.release();
            objectUrlLeases.get(url)?.invalidationListeners.clear();
            objectUrlLeases.delete(url);
            URL.revokeObjectURL(url);
        },
        terminate() {
            terminated = true;
            for (const requestId of activePreviewRequestIds) {
                cancelPreviewRequest(requestId);
            }
            activePreviewRequestIds.clear();
            activePreviewRequestIdsByPage.clear();
            for (const [
                objectUrl,
                entry,
            ] of objectUrlLeases) {
                entry.lease?.release();
                URL.revokeObjectURL(objectUrl);
            }
            objectUrlLeases.clear();
            surfaceBudget.releaseScope(surfaceScopeId);
        },
    };
}
