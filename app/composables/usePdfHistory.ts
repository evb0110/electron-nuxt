import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { TWorkspaceUndoSource } from '@app/modules/workspace-shell/public';
import { capturePdfReloadSnapshot } from '@app/utils/pdf-viewer/pdf-reload-waiter/capturePdfReloadSnapshot';
import { createPdfReloadWaiter } from '@app/utils/pdf-viewer/pdf-reload-waiter/createPdfReloadWaiter';

interface IWaitForPdfReloadOptions {captureScrollSnapshot?: boolean;}

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
    shouldPreferTimelineUndo?: (() => boolean) | undefined;
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
        shouldPreferTimelineUndo,
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
    function preparePdfReloadWaiter(
        pageToRestore: number,
        opts?: IWaitForPdfReloadOptions,
    ) {
        const shouldCaptureScrollSnapshot = opts?.captureScrollSnapshot !== false;
        const normalizedPageToRestore = Math.max(1, Math.floor(pageToRestore));
        const capturedReloadState = shouldCaptureScrollSnapshot
            ? capturePdfReloadSnapshot(pdfViewerRef.value, normalizedPageToRestore)
            : {
                scrollSnapshot: null,
                pageToRestore: normalizedPageToRestore,
            };
        currentPage.value = capturedReloadState.pageToRestore;

        return createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef,
            resetSearchCache,
            pageToRestore: capturedReloadState.pageToRestore,
            scrollSnapshot: capturedReloadState.scrollSnapshot,
            captureScrollSnapshot: shouldCaptureScrollSnapshot,
        });
    }

    function waitForPdfReload(
        pageToRestore: number,
        opts?: IWaitForPdfReloadOptions,
    ) {
        return preparePdfReloadWaiter(pageToRestore, opts).promise;
    }

    async function handleUndo() {
        if (isAnySaving.value || !canUndo.value) {
            return;
        }
        if (isAnnotationUndoContext.value && shouldPreferTimelineUndo?.() !== true) {
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
                ? preparePdfReloadWaiter(pageToRestore)
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
                ? preparePdfReloadWaiter(pageToRestore)
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
        preparePdfReloadWaiter,
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
