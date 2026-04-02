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
}

interface ICreatePdfReloadWaiterOptions {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    resetSearchCache: () => void;
    pageToRestore: number;
}

export function createPdfReloadWaiter(options: ICreatePdfReloadWaiterOptions) {
    const initialDoc = options.pdfDocument.value;
    const isCancelled = ref(false);
    const scrollSnapshot = options.pdfViewerRef.value?.captureScrollSnapshot?.() ?? null;

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

            options.resetSearchCache();
            await nextTick();
            const viewer = options.pdfViewerRef.value;
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
