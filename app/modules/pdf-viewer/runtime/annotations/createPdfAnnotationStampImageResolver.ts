import type {IPlacedImageEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {formatPdfJsAnnotationRef} from '@app/utils/pdfAnnotationRefs';
import {BrowserLogger} from '@app/utils/browserLogger';
import {AnnotationMode} from '@app/services/pdfjs/runtimeLib';
import {resolvePdfJsStampImageDataUrl} from '@app/modules/pdf-viewer/runtime/annotations/resolvePdfJsStampImageDataUrl';

export function createPdfAnnotationStampImageResolver(documentSession: TPdfDocumentSession) {
    const stampImageCacheByDocument = new WeakMap<object, Map<string, string>>();
    const stampImageRequestsByDocument = new WeakMap<object, Map<string, Promise<string | null>>>();

    return async function resolveStampImage(entity: IPlacedImageEntity) {
        const pdfDocument = documentSession.pdfDocument.value;
        if (!pdfDocument) {
            return null;
        }
        const imageRef = formatPdfJsAnnotationRef(entity.image);
        const cachedImages = stampImageCacheByDocument.get(pdfDocument) ?? new Map<string, string>();
        stampImageCacheByDocument.set(pdfDocument, cachedImages);
        const cachedImage = cachedImages.get(imageRef);
        if (cachedImage) {
            return cachedImage;
        }
        const pendingRequests = stampImageRequestsByDocument.get(pdfDocument)
            ?? new Map<string, Promise<string | null>>();
        stampImageRequestsByDocument.set(pdfDocument, pendingRequests);
        const pendingRequest = pendingRequests.get(imageRef);
        if (pendingRequest) {
            return pendingRequest;
        }
        const request = (async () => {
            let lease: Awaited<ReturnType<TPdfDocumentSession['leasePage']>> | null = null;
            try {
                lease = await documentSession.leasePage(
                    entity.pageIndex + 1,
                    'transient-background',
                );
                await lease.page.getOperatorList({annotationMode: AnnotationMode.ENABLE});
                const dataUrl = resolvePdfJsStampImageDataUrl(lease.page, entity.image);
                if (dataUrl) {
                    cachedImages.set(imageRef, dataUrl);
                }
                return dataUrl;
            } catch (error) {
                BrowserLogger.warn(
                    'pdf-annotations',
                    `Failed to resolve persisted stamp image on page ${String(entity.pageIndex + 1)}`,
                    error,
                );
                return null;
            } finally {
                lease?.release();
            }
        })();
        pendingRequests.set(imageRef, request);
        try {
            return await request;
        } finally {
            if (pendingRequests.get(imageRef) === request) {
                pendingRequests.delete(imageRef);
            }
        }
    };
}
