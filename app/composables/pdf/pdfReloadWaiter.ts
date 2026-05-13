import type { Ref } from 'vue';
import { until } from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdf';

const PDF_RELOAD_TIMEOUT_MS = 8000;

interface IPdfReloadWaiterViewer {
    scrollToPage: (page: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    waitForViewerLoadSettled?: () => Promise<void>;
}

interface ICreatePdfReloadWaiterOptions {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    resetSearchCache: () => void;
    pageToRestore: number;
    scrollSnapshot?: IScrollSnapshot | null;
    captureScrollSnapshot?: boolean;
}

export function capturePdfReloadSnapshot(
    viewer: IPdfReloadWaiterViewer | null,
    fallbackPage: number,
) {
    const scrollSnapshot = viewer?.captureScrollSnapshot?.() ?? null;
    const anchorPage = typeof scrollSnapshot?.anchorPage === 'number' && Number.isFinite(scrollSnapshot.anchorPage)
        ? Math.max(1, Math.floor(scrollSnapshot.anchorPage))
        : null;

    return {
        scrollSnapshot,
        pageToRestore: anchorPage ?? Math.max(1, Math.floor(fallbackPage)),
    };
}

export function createPdfReloadWaiter(options: ICreatePdfReloadWaiterOptions) {
    const initialDoc = options.pdfDocument.value;
    const isCancelled = ref(false);
    const captureScrollSnapshot = options.captureScrollSnapshot !== false;
    const scrollSnapshot = captureScrollSnapshot
        ? options.scrollSnapshot ?? options.pdfViewerRef.value?.captureScrollSnapshot?.() ?? null
        : null;

    const promise = until(() => ({
        doc: options.pdfDocument.value,
        cancelled: isCancelled.value,
    }))
        .toMatch(({
            doc,
            cancelled,
        }) => cancelled || Boolean(doc && doc !== initialDoc), { timeout: PDF_RELOAD_TIMEOUT_MS })
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
                let settleTimer: ReturnType<typeof setTimeout> | null = null;
                try {
                    await Promise.race([
                        viewer.waitForViewerLoadSettled(),
                        new Promise<never>((_resolve, reject) => {
                            settleTimer = setTimeout(() => {
                                settleTimer = null;
                                reject(new Error('Timed out waiting for viewer load to settle after PDF reload'));
                            }, PDF_RELOAD_TIMEOUT_MS);
                        }),
                    ]);
                } finally {
                    if (settleTimer) {
                        clearTimeout(settleTimer);
                    }
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
