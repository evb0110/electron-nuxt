import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browserLogger';

const DOCUMENT_OPEN_VISUAL_SETTLE_TIMEOUT_MS = 4_000;

interface IUseDocumentOpenVisualSettleOptions {
    tabId: string;
    hasPdf: Ref<boolean>;
    pdfSrc: Ref<unknown>;
    pdfDocument: Ref<unknown>;
    totalPages: Ref<number>;
    pageLabelsResolved: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfError: Ref<unknown>;
    djvuError: Ref<unknown>;
    showNativeDjvuViewer: Ref<boolean>;
    markAnnotationCommentsLoading: () => void;
}

export const useDocumentOpenVisualSettle = (options: IUseDocumentOpenVisualSettleOptions) => {
    const initialDocumentVisualReady = ref(false);
    let documentOpenVisualSettlePromise: Promise<void> | null = null;
    let resolveDocumentOpenVisualSettlePromise: (() => void) | null = null;

    function ensureDocumentOpenVisualSettlePromise() {
        if (!documentOpenVisualSettlePromise) {
            documentOpenVisualSettlePromise = new Promise<void>((resolve) => {
                resolveDocumentOpenVisualSettlePromise = resolve;
            });
        }

        return documentOpenVisualSettlePromise;
    }

    function resolveDocumentOpenVisualSettle() {
        resolveDocumentOpenVisualSettlePromise?.();
        documentOpenVisualSettlePromise = null;
        resolveDocumentOpenVisualSettlePromise = null;
    }

    function resetDocumentOpenVisualSettleWaiter() {
        initialDocumentVisualReady.value = false;
    }

    function hasSettledDocumentOpenVisualState() {
        if (options.pdfError.value || options.djvuError.value) {
            return true;
        }

        if (options.showNativeDjvuViewer.value) {
            return true;
        }

        return Boolean(
            options.pdfSrc.value
            && options.pdfDocument.value
            && options.totalPages.value > 0
            && !options.isLoading.value
            && initialDocumentVisualReady.value,
        );
    }

    function resolveDocumentOpenVisualSettleIfReady() {
        if (hasSettledDocumentOpenVisualState()) {
            resolveDocumentOpenVisualSettle();
        }
    }

    function handlePdfInitialVisualReady() {
        initialDocumentVisualReady.value = true;
        resolveDocumentOpenVisualSettleIfReady();
    }

    function handlePdfInitialVisualPending() {
        options.markAnnotationCommentsLoading();
        resetDocumentOpenVisualSettleWaiter();
    }

    function waitForDocumentOpenVisualSettleTimeout() {
        return delay(DOCUMENT_OPEN_VISUAL_SETTLE_TIMEOUT_MS).then(() => 'timeout' as const);
    }

    async function waitForDocumentOpenSettled() {
        await nextTick();
        resolveDocumentOpenVisualSettleIfReady();
        if (hasSettledDocumentOpenVisualState()) {
            return;
        }

        await Promise.race([
            ensureDocumentOpenVisualSettlePromise(),
            waitForDocumentOpenVisualSettleTimeout(),
        ]);
        await nextTick();

        if (hasSettledDocumentOpenVisualState()) {
            return;
        }

        BrowserLogger.warn('recent-open', 'Document open visual settle timed out', {
            tabId: options.tabId,
            hasPdf: options.hasPdf.value,
            hasPdfSrc: Boolean(options.pdfSrc.value),
            hasPdfDocument: Boolean(options.pdfDocument.value),
            totalPages: options.totalPages.value,
            pageLabelsResolved: options.pageLabelsResolved.value,
            isLoading: options.isLoading.value,
            showNativeDjvuViewer: options.showNativeDjvuViewer.value,
            hasPdfError: Boolean(options.pdfError.value),
            hasDjvuError: Boolean(options.djvuError.value),
        });
        resolveDocumentOpenVisualSettle();
    }

    watch([
        options.pdfDocument,
        options.totalPages,
        options.pageLabelsResolved,
        options.isLoading,
        options.showNativeDjvuViewer,
        initialDocumentVisualReady,
    ], () => {
        resolveDocumentOpenVisualSettleIfReady();
    });

    return {
        handlePdfInitialVisualPending,
        handlePdfInitialVisualReady,
        resetDocumentOpenVisualSettleWaiter,
        resolveDocumentOpenVisualSettleIfReady,
        waitForDocumentOpenSettled,
    };
};
