import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TFitMode } from '@app/types/pdfContracts';
import type { TPdfViewMode } from '@contracts/shared';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IPageRange } from '@app/types/pdfUi';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createPageNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { usePdfInitialCanvasCommitCoordinator } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfInitialCanvasCommitCoordinator';
import type { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer/runtime/rendering/usePdfViewerRenderingRuntime';
import { shouldDeferPdfDprRerenderForResize } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerOutputScale';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';

type TSinglePageOptions = Parameters<typeof usePdfSinglePageNavigationController>[0];
type TTransactionOptions = Parameters<typeof usePdfViewerTransactionController>[0];

interface IUsePdfViewerNavigationOrchestrationOptions {
    singlePageOptions: TSinglePageOptions;
    transactionOptions: Omit<TTransactionOptions, 'navigationState'>;
    viewerCurrentPage: Ref<number>;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    initialCanvasCommit: ReturnType<typeof usePdfInitialCanvasCommitCoordinator>;
    commitInitialVisualReady: (pageNumber: number) => boolean;
    zoom: Ref<number>;
    fitMode: Ref<TFitMode>;
    viewMode: Ref<TPdfViewMode>;
    outputScale: Ref<number>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    isResizing: Ref<boolean>;
    visibleRange: Ref<IPageRange>;
    reRenderAllVisiblePages: ReturnType<typeof usePdfViewerRenderingRuntime>['reRenderAllVisiblePages'];
    isActive: Ref<boolean>;
    userViewportInteractionEpoch: Ref<number>;
}

export const usePdfViewerNavigationOrchestration = (
    options: IUsePdfViewerNavigationOrchestrationOptions,
) => {
    const singlePageScroll = usePdfSinglePageNavigationController(options.singlePageOptions);

    watch(
        () => singlePageScroll.viewportAuthority.activeIntent.value,
        (activeIntent, previousIntent) => {
            if (activeIntent === null && previousIntent !== null) {
                const terminalOutcome = singlePageScroll.viewportAuthority.getTerminalOutcome(previousIntent.id);
                if (terminalOutcome === 'settled') {
                    singlePageScroll.commitCurrentViewportIfSettled(
                        singlePageScroll.viewportAuthority.currentPage.value,
                    );
                }
            }
            if (activeIntent !== null) {
                return;
            }
            const surface = options.chassisAuthority?.openSurface;
            const committedRender = surface?.snapshot.value.committedRender;
            if (!surface || !committedRender || surface.snapshot.value.committedViewport) {
                return;
            }
            if (singlePageScroll.commitCurrentViewportIfSettled(committedRender.pageNumber)) {
                options.initialCanvasCommit.tryComplete(committedRender.pageNumber, options.commitInitialVisualReady);
            }
        },
        { flush: 'sync' },
    );

    let anchoredZoomAlreadySubmitted: number | null = null;
    watch(options.zoom, (value) => {
        if (
            anchoredZoomAlreadySubmitted !== null
            && Math.abs(anchoredZoomAlreadySubmitted - value) < 0.000_001
        ) {
            anchoredZoomAlreadySubmitted = null;
            return;
        }
        anchoredZoomAlreadySubmitted = null;
        void singlePageScroll.submitViewportStateIntent('zoom', { zoom: value });
    });
    watch(options.fitMode, () => { void singlePageScroll.submitViewportStateIntent('fit'); });
    watch(options.viewMode, value => {
        void singlePageScroll.submitViewportStateIntent('view-mode', { viewMode: value });
    });
    watch(options.outputScale, value => {
        void singlePageScroll.submitViewportStateIntent('dpr', { dpr: value });
    });
    watch(options.outputScale, (nextScale, previousScale) => {
        if (nextScale === previousScale || !options.pdfDocument.value || options.isLoading.value) {
            return;
        }
        if (shouldDeferPdfDprRerenderForResize(options.isResizing.value)) {
            BrowserLogger.diagnostic('pdf-nav', '[dpr-change] deferred to active layout-resize settle', {
                previousScale,
                nextScale,
            });
            return;
        }
        runGuardedTask(
            () => options.reRenderAllVisiblePages(() => options.visibleRange.value, {
                rerenderSource: PDF_RERENDER_SOURCE.DprChange,
                renderBufferOverride: 0,
            }),
            {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to re-render PDF pages after display scale change',
            },
        );
    });
    watch(options.isActive, (active) => {
        if (!active) {
            singlePageScroll.viewportAuthority.suspend();
            return;
        }
        void singlePageScroll.submitViewportStateIntent('activation');
    });

    const transactionController = usePdfViewerTransactionController({
        ...options.transactionOptions,
        navigationState: singlePageScroll.navigationState,
    });

    function markUserViewportInteraction() {
        options.userViewportInteractionEpoch.value += 1;
        singlePageScroll.cancelProgrammaticNavigation('user-viewport-interaction');
    }

    function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
        const request = createPageNavigationRequest(options.viewerCurrentPage.value, 'bookmark');
        request.target = {
            kind: 'named-dest',
            destination: dest,
        };
        request.alignment = 'page-top';
        request.readiness = 'page-canvas';
        singlePageScroll.submitNavigationRequest(request);
    }

    return {
        singlePageScroll,
        transactionController,
        markUserViewportInteraction,
        handleLinkDestination,
        markAnchoredZoomSubmitted: (zoom: number) => {
            anchoredZoomAlreadySubmitted = zoom;
        },
    };
};
