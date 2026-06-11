import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { TWorkspaceUndoSource } from '@app/modules/workspace-shell/public';
import { capturePdfReloadSnapshot } from '@app/utils/pdf-viewer/pdf-reload-waiter/capturePdfReloadSnapshot';
import { createPdfReloadWaiter } from '@app/utils/pdf-viewer/pdf-reload-waiter/createPdfReloadWaiter';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IWaitForPdfReloadOptions {captureScrollSnapshot?: boolean;}
type THistoryDirection = 'undo' | 'redo';
type TShouldPreferTimelineUndo = (
    direction?: THistoryDirection,
    source?: TWorkspaceUndoSource | null,
) => boolean;
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
        shouldPreferTimelineUndo: boolean;
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
    isAnnotationUndoContext: Ref<boolean>;
    shouldPreferTimelineUndo?: TShouldPreferTimelineUndo | undefined;
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
    let preferredTimelineRedoSource: TWorkspaceUndoSource | null = null;

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
        const prefersTimeline = shouldPreferTimelineUndo?.(direction, source) === true;
        const redoesPreferredTimelineUndo = direction === 'redo'
            && source !== null
            && source === preferredTimelineRedoSource;
        if (isAnnotationUndoContext.value && !prefersTimeline && !redoesPreferredTimelineUndo) {
            return {
                kind: 'annotation',
                direction,
            };
        }

        return {
            kind: 'timeline',
            direction,
            source,
            shouldPreferTimelineUndo: prefersTimeline,
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
                shouldPreferTimelineUndo: route.shouldPreferTimelineUndo,
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
            preferredTimelineRedoSource = null;
            pdfViewerRef.value?.undoAnnotation();
            return;
        }

        const didUndo = await runTimelineHistoryRoute(route, undoHistory);
        if (didUndo) {
            preferredTimelineRedoSource = route.shouldPreferTimelineUndo
                ? route.source
                : null;
        }
    }

    async function handleRedo() {
        const route = resolveHistoryRoute('redo');
        if (route.kind === 'blocked') {
            return;
        }
        if (route.kind === 'annotation') {
            preferredTimelineRedoSource = null;
            pdfViewerRef.value?.redoAnnotation();
            return;
        }

        const didRedo = await runTimelineHistoryRoute(route, redoHistory);
        if (didRedo) {
            preferredTimelineRedoSource = null;
        }
    }

    return {
        preparePdfReloadWaiter,
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
