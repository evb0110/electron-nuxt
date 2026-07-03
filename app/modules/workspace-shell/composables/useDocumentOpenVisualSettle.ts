import type { Ref } from 'vue';
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
    showNativePdfViewer?: Ref<boolean>;
    markAnnotationCommentsLoading: () => void;
}

export const useDocumentOpenVisualSettle = (options: IUseDocumentOpenVisualSettleOptions) => {
    const initialDocumentVisualReady = ref(false);
    let documentOpenVisualSettlePromise: Promise<void> | null = null;
    let resolveDocumentOpenVisualSettlePromise: (() => void) | null = null;

    function ensureDocumentOpenVisualSettlePromise() {
        documentOpenVisualSettlePromise ??= new Promise<void>((resolve) => {
            resolveDocumentOpenVisualSettlePromise = resolve;
        });

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

        if (options.showNativeDjvuViewer.value || options.showNativePdfViewer?.value) {
            return Boolean(
                !options.isLoading.value
                && initialDocumentVisualReady.value,
            );
        }

        return Boolean(
            options.pdfSrc.value
            && options.pdfDocument.value
            && options.totalPages.value > 0
            && options.pageLabelsResolved.value
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

    function createDocumentOpenVisualSettleTimeout() {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const promise = new Promise<'timeout'>((resolve) => {
            timeoutId = setTimeout(() => {
                timeoutId = null;
                resolve('timeout');
            }, DOCUMENT_OPEN_VISUAL_SETTLE_TIMEOUT_MS);
        });

        return {
            promise,
            cancel: () => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            },
        };
    }

    async function waitForDocumentOpenSettled() {
        await nextTick();
        resolveDocumentOpenVisualSettleIfReady();
        if (hasSettledDocumentOpenVisualState()) {
            return;
        }

        const timeout = createDocumentOpenVisualSettleTimeout();
        const settleResult = await Promise.race([
            ensureDocumentOpenVisualSettlePromise().then(() => 'settled' as const),
            timeout.promise,
        ]).finally(() => {
            timeout.cancel();
        });
        await nextTick();

        if (hasSettledDocumentOpenVisualState()) {
            return;
        }

        if (settleResult !== 'timeout') {
            return;
        }

        const error = new Error('Document open visual settle timed out');
        BrowserLogger.warn('recent-open', error.message, {
            tabId: options.tabId,
            hasPdf: options.hasPdf.value,
            hasPdfSrc: Boolean(options.pdfSrc.value),
            hasPdfDocument: Boolean(options.pdfDocument.value),
            totalPages: options.totalPages.value,
            pageLabelsResolved: options.pageLabelsResolved.value,
            isLoading: options.isLoading.value,
            showNativeDjvuViewer: options.showNativeDjvuViewer.value,
            showNativePdfViewer: options.showNativePdfViewer?.value ?? false,
            hasPdfError: Boolean(options.pdfError.value),
            hasDjvuError: Boolean(options.djvuError.value),
        });
        throw error;
    }

    watch([
        options.pdfDocument,
        options.totalPages,
        options.pageLabelsResolved,
        options.isLoading,
        options.pdfError,
        options.djvuError,
        options.showNativeDjvuViewer,
        ...(options.showNativePdfViewer ? [options.showNativePdfViewer] : []),
        initialDocumentVisualReady,
    ], () => {
        resolveDocumentOpenVisualSettleIfReady();
    });

    return {
        handlePdfInitialVisualPending,
        handlePdfInitialVisualReady,
        initialDocumentVisualReady,
        resetDocumentOpenVisualSettleWaiter,
        resolveDocumentOpenVisualSettleIfReady,
        waitForDocumentOpenSettled,
    };
};
