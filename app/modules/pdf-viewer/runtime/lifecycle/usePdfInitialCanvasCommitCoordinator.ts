import type { Ref } from 'vue';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';

interface IPendingInitialCanvasCommit {
    generation: number;
    pageNumber: number | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    canvasCommitted: boolean;
}

interface IUsePdfInitialCanvasCommitCoordinatorOptions {
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    currentPage: Ref<number>;
}

export const usePdfInitialCanvasCommitCoordinator = (
    options: IUsePdfInitialCanvasCommitCoordinatorOptions,
) => {
    let pending: IPendingInitialCanvasCommit | null = null;

    function finish() {
        if (!pending) {
            return;
        }
        pending = null;
    }

    function begin(generation: number) {
        if (pending) {
            pending.reject(new Error('Initial canvas commit superseded'));
        }
        const committedRender = options.chassisAuthority?.openSurface.snapshot.value.committedRender;
        const canvasCommitted = committedRender?.generation === generation;
        let resolvePromise!: () => void;
        let rejectPromise!: (error: Error) => void;
        const promise = new Promise<void>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        void promise.catch(() => {});
        pending = {
            generation,
            pageNumber: null,
            promise,
            resolve: resolvePromise,
            reject: rejectPromise,
            canvasCommitted,
        };
        if (canvasCommitted) {
            resolvePromise();
        }
    }

    function resolveCanvas(generation: number, pageNumber: number) {
        if (
            !pending
            || pending.generation !== generation
            || options.currentPage.value !== pageNumber
        ) {
            logPdfRenderTrace('initial-canvas-commit-ignored', () => ({
                generation,
                pageNumber,
                currentPage: options.currentPage.value,
                pendingGeneration: pending?.generation ?? null,
                pendingPage: pending?.pageNumber ?? null,
            }));
            return;
        }
        // The load lifecycle can begin waiting for page 1 before an early
        // Recent/navigation command changes the authoritative destination.
        // A same-generation canvas accepted for the live current page is the
        // initial canvas now; retaining the obsolete wait page would leave the
        // document-open promise pending after the visible target has committed.
        pending.pageNumber = pageNumber;
        if (!pending.canvasCommitted) {
            pending.canvasCommitted = true;
            pending.resolve();
            logPdfRenderTrace('initial-canvas-commit-resolved', {
                generation,
                pageNumber,
            });
        }
    }

    function tryComplete(pageNumber: number, commitInitialVisualReady: (page: number) => boolean) {
        if (!pending) {
            return false;
        }
        const surface = options.chassisAuthority?.openSurface;
        const snapshot = surface?.snapshot.value;
        const fence = snapshot?.committedRender ?? null;
        if (
            !surface
            || !snapshot
            || !fence
            || snapshot.committedViewport?.pageNumber !== pageNumber
            || fence.pageNumber !== pageNumber
        ) {
            return false;
        }
        if (snapshot.phase === 'viewport-committed' && !surface.markReady(fence)) {
            return false;
        }
        const readySnapshot = surface.snapshot.value;
        if (
            readySnapshot.phase !== 'ready'
            || readySnapshot.committedRender?.pageNumber !== pageNumber
            || readySnapshot.committedViewport?.pageNumber !== pageNumber
            || !commitInitialVisualReady(pageNumber)
        ) {
            return false;
        }
        finish();
        return true;
    }

    async function waitForCanvas(pageNumber: number) {
        if (!pending) {
            return;
        }
        pending.pageNumber = pageNumber;
        logPdfRenderTrace('initial-canvas-commit-waiting', () => ({
            generation: pending?.generation ?? null,
            pageNumber,
            currentPage: options.currentPage.value,
            canvasCommitted: pending?.canvasCommitted ?? false,
        }));
        await pending.promise;
    }

    function isInitialVisualCommitted() {
        const snapshot = options.chassisAuthority?.openSurface.snapshot.value;
        return snapshot?.phase === 'ready'
            && snapshot.committedRender?.pageNumber === options.currentPage.value
            && snapshot.committedViewport?.pageNumber === options.currentPage.value;
    }

    function isInitialCanvasCommitted() {
        const snapshot = options.chassisAuthority?.openSurface.snapshot.value;
        return snapshot?.committedRender?.pageNumber === options.currentPage.value
            && (
                snapshot.phase === 'canvas-committed'
                || snapshot.phase === 'viewport-committed'
                || snapshot.phase === 'ready'
            );
    }

    onScopeDispose(() => {
        if (!pending) {
            return;
        }
        pending.reject(new Error('PDF viewer disposed before initial canvas commit'));
        pending = null;
    });

    return {
        begin,
        isInitialCanvasCommitted,
        isInitialVisualCommitted,
        resolveCanvas,
        tryComplete,
        waitForCanvas,
    };
};
