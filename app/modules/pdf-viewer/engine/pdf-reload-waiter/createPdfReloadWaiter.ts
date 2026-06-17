import type { Ref } from 'vue';
import { until } from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IPdfReloadWaiterViewer } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
import { BrowserLogger } from '@app/utils/browserLogger';

const PDF_DOCUMENT_RELOAD_TIMEOUT_MS = 8000;
const PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS = 30000;

interface ICreatePdfReloadWaiterOptions {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    resetSearchCache: () => void;
    pageToRestore: number;
    scrollSnapshot?: IScrollSnapshot | null;
    captureScrollSnapshot?: boolean;
    restoreScroll?: boolean;
}

export function createPdfReloadWaiter(options: ICreatePdfReloadWaiterOptions) {
    const initialDoc = options.pdfDocument.value;
    const isCancelled = ref(false);
    const shouldRestoreScroll = options.restoreScroll !== false;
    const captureScrollSnapshot = options.captureScrollSnapshot !== false;
    const scrollSnapshot = shouldRestoreScroll && captureScrollSnapshot
        ? options.scrollSnapshot ?? options.pdfViewerRef.value?.captureScrollSnapshot?.() ?? null
        : null;

    const promise = until(() => ({
        doc: options.pdfDocument.value,
        cancelled: isCancelled.value,
    }))
        .toMatch(({
            doc,
            cancelled,
        }) => cancelled || Boolean(doc && doc !== initialDoc), { timeout: PDF_DOCUMENT_RELOAD_TIMEOUT_MS })
        .then(async ({
            doc,
            cancelled,
        }) => {
            if (cancelled || !doc || doc === initialDoc) {
                return;
            }

            const matchedDoc = doc;
            const viewer = options.pdfViewerRef.value;
            if (viewer?.waitForViewerLoadSettled) {
                const timeoutController = new AbortController();
                try {
                    const didSettle = await Promise.race([
                        viewer.waitForViewerLoadSettled().then(() => true),
                        delay(PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS, { signal: timeoutController.signal }).then(() => false),
                    ]);
                    if (!didSettle) {
                        BrowserLogger.warn('loader', 'Timed out waiting for viewer load to settle after PDF reload; continuing', { timeoutMs: PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS });
                    }
                } catch (error) {
                    BrowserLogger.warn('loader', 'Viewer load settle hook failed after PDF reload; continuing', { error });
                } finally {
                    timeoutController.abort();
                }
            }
            if (isCancelled.value) {
                return;
            }

            if (options.pdfDocument.value !== matchedDoc) {
                return;
            }
            options.resetSearchCache();
            await nextTick();
            if (isCancelled.value || options.pdfDocument.value !== matchedDoc) {
                return;
            }
            if (!shouldRestoreScroll) {
                return;
            }
            if (!captureScrollSnapshot) {
                viewer?.scrollToPage(options.pageToRestore);
                return;
            }
            if (viewer?.restoreScrollSnapshot) {
                viewer.restoreScrollSnapshot(scrollSnapshot, { fallbackPage: options.pageToRestore });
                return;
            }
            viewer?.scrollToPage(options.pageToRestore);
        });

    return {
        promise,
        cancel: () => {
            isCancelled.value = true;
        },
    };
}
