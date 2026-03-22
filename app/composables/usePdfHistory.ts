import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import { until } from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { TWorkspaceUndoSource } from '@app/modules/workspace-shell/composables/useWorkspaceUndoTimeline';

const PDF_RELOAD_TIMEOUT_MS = 8000;

export const usePdfHistory = (deps: {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        captureScrollSnapshot?: () => IScrollSnapshot | null;
        restoreScrollSnapshot?: (
            snapshot: IScrollSnapshot | null,
            options?: { fallbackPage?: number | null; },
        ) => void;
        undoAnnotation: () => void;
        redoAnnotation: () => void 
    } | null>;
    currentPage: Ref<number>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    isAnnotationUndoContext: Ref<boolean>;
    nextUndoSource: Ref<TWorkspaceUndoSource | null>;
    nextRedoSource: Ref<TWorkspaceUndoSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    resetSearchCache: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    undoHistory: () => Promise<boolean>;
    redoHistory: () => Promise<boolean>;
}) => {
    const {
        pdfDocument,
        pdfViewerRef,
        currentPage,
        isAnySaving,
        isHistoryBusy,
        canUndo,
        canRedo,
        isAnnotationUndoContext,
        nextUndoSource,
        nextRedoSource,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache,
        undoHistory,
        redoHistory,
    } = deps;

    /**
     * Starts watching for a PDF document instance swap and resolves when
     * the reload completes (or times out). A cancel path is exposed so
     * undo/redo no-op operations can tear the watcher down immediately.
     */
    function createPdfReloadWaiter(pageToRestore: number) {
        const initialDoc = pdfDocument.value;
        const isCancelled = ref(false);
        const scrollSnapshot = pdfViewerRef.value?.captureScrollSnapshot?.() ?? null;

        const promise = until(() => ({
            doc: pdfDocument.value,
            cancelled: isCancelled.value,
        }))
            .toMatch(({
                doc,
                cancelled,
            }) => cancelled || Boolean(doc && doc !== initialDoc), {timeout: PDF_RELOAD_TIMEOUT_MS})
            .then(async ({
                doc,
                cancelled,
            }) => {
                if (cancelled || !doc || doc === initialDoc) {
                    return;
                }

                resetSearchCache();
                await nextTick();
                const viewer = pdfViewerRef.value;
                if (viewer?.restoreScrollSnapshot) {
                    viewer.restoreScrollSnapshot(scrollSnapshot, { fallbackPage: pageToRestore });
                    return;
                }
                viewer?.scrollToPage(pageToRestore);
            });

        return {
            promise,
            cancel: () => {
                isCancelled.value = true;
            },
        };
    }

    function waitForPdfReload(pageToRestore: number) {
        return createPdfReloadWaiter(pageToRestore).promise;
    }

    async function handleUndo() {
        if (isAnySaving.value || !canUndo.value) {
            return;
        }
        if (isAnnotationUndoContext.value) {
            pdfViewerRef.value?.undoAnnotation();
            return;
        }
        if (isHistoryBusy.value) {
            return;
        }
        isHistoryBusy.value = true;
        try {
            const undoSource = nextUndoSource.value;
            if (!undoSource) {
                return;
            }
            if (undoSource === 'file' && workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
            const reloadWaiter = undoSource === 'file'
                ? createPdfReloadWaiter(pageToRestore)
                : null;
            const didUndo = await undoHistory();
            if (didUndo && reloadWaiter) {
                await reloadWaiter.promise;
            } else if (reloadWaiter) {
                reloadWaiter.cancel();
            }
        } finally {
            isHistoryBusy.value = false;
        }
    }

    async function handleRedo() {
        if (isAnySaving.value || !canRedo.value) {
            return;
        }
        if (isAnnotationUndoContext.value) {
            pdfViewerRef.value?.redoAnnotation();
            return;
        }
        if (isHistoryBusy.value) {
            return;
        }
        isHistoryBusy.value = true;
        try {
            const redoSource = nextRedoSource.value;
            if (!redoSource) {
                return;
            }
            if (redoSource === 'file' && workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
            const reloadWaiter = redoSource === 'file'
                ? createPdfReloadWaiter(pageToRestore)
                : null;
            const didRedo = await redoHistory();
            if (didRedo && reloadWaiter) {
                await reloadWaiter.promise;
            } else if (reloadWaiter) {
                reloadWaiter.cancel();
            }
        } finally {
            isHistoryBusy.value = false;
        }
    }

    return {
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
