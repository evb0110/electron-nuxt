import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';
import { capturePdfReloadSnapshot } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/capturePdfReloadSnapshot';
import { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IWaitForPdfReloadOptions {captureScrollSnapshot?: boolean;}
type THistoryDirection = 'undo' | 'redo';
type THistoryRoute = (
    | {kind: 'blocked';}
    | {
        kind: 'annotation';
        direction: THistoryDirection;
    }
    | {
        kind: 'timeline';
        direction: THistoryDirection;
        source: TWorkspaceUndoSource | null;
    }
);

const HISTORY_LOG_SECTION = 'pdf-history';

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
        redoAnnotation: () => void;
    } | null>;
    currentPage: Ref<number>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    canUndoAnnotation?: Ref<boolean> | undefined;
    canRedoAnnotation?: Ref<boolean> | undefined;
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
        canUndoAnnotation,
        canRedoAnnotation,
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

    function getCanUseHistory(direction: THistoryDirection) {
        return direction === 'undo'
            ? canUndo.value
            : canRedo.value;
    }

    function getCanUseAnnotationHistory(direction: THistoryDirection) {
        const canUseAnnotation = direction === 'undo'
            ? canUndoAnnotation
            : canRedoAnnotation;
        return canUseAnnotation?.value ?? getCanUseHistory(direction);
    }

    function getTimelineHistorySource(direction: THistoryDirection) {
        return direction === 'undo'
            ? nextUndoSource.value
            : nextRedoSource.value;
    }

    function resolveHistoryRoute(direction: THistoryDirection): THistoryRoute {
        if (isAnySaving.value || !getCanUseHistory(direction)) {
            return {kind: 'blocked'};
        }

        const source = getTimelineHistorySource(direction);
        if (source) {
            return {
                kind: 'timeline',
                direction,
                source,
            };
        }

        if (
            isAnnotationUndoContext.value
            && getCanUseAnnotationHistory(direction)
        ) {
            return {
                kind: 'annotation',
                direction,
            };
        }

        return {
            kind: 'timeline',
            direction,
            source,
        };
    }

    function reportMissingTimelineSource(route: Extract<THistoryRoute, {kind: 'timeline';}>) {
        BrowserLogger.warn(
            HISTORY_LOG_SECTION,
            `${route.direction === 'undo' ? 'Undo' : 'Redo'} requested but no timeline history source was available`,
            {
                direction: route.direction,
                canUndo: canUndo.value,
                canRedo: canRedo.value,
                isAnnotationUndoContext: isAnnotationUndoContext.value,
            },
        );
    }

    async function runTimelineHistoryRoute(
        route: Extract<THistoryRoute, {kind: 'timeline';}>,
        runHistory: () => Promise<boolean>,
    ) {
        if (isHistoryBusy.value) {
            return false;
        }
        isHistoryBusy.value = true;
        try {
            const historySource = route.source;
            if (!historySource) {
                reportMissingTimelineSource(route);
                return false;
            }
            if (historySource === 'file' && workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
            const reloadWaiter = historySource === 'file'
                ? preparePdfReloadWaiter(pageToRestore)
                : null;
            const didRun = await runHistory();
            if (didRun && reloadWaiter) {
                await reloadWaiter.promise;
            } else if (reloadWaiter) {
                reloadWaiter.cancel();
            }
            return didRun;
        } finally {
            isHistoryBusy.value = false;
        }
    }

    async function handleUndo() {
        const route = resolveHistoryRoute('undo');
        if (route.kind === 'blocked') {
            return;
        }
        if (route.kind === 'annotation') {
            pdfViewerRef.value?.undoAnnotation();
            return;
        }

        await runTimelineHistoryRoute(route, undoHistory);
    }

    async function handleRedo() {
        const route = resolveHistoryRoute('redo');
        if (route.kind === 'blocked') {
            return;
        }
        if (route.kind === 'annotation') {
            pdfViewerRef.value?.redoAnnotation();
            return;
        }

        await runTimelineHistoryRoute(route, redoHistory);
    }

    return {
        preparePdfReloadWaiter,
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
