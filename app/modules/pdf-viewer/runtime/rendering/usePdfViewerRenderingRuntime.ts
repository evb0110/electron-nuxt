import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { usePdfPageRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {
    IPageRenderStallPayload,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {
    IPageRange,
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { IPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

interface IUsePdfViewerRenderingRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    document: IUsePdfPageRendererOptions['document'];
    currentPage: Ref<number>;
    isActive: ComputedRef<boolean>;
    effectiveScale: ComputedRef<number>;
    outputScale: Ref<number>;
    rasterDisplayProfile: ComputedRef<TPdfRasterDisplayProfile | null>;
    bufferPages: ComputedRef<number>;
    showAnnotations: ComputedRef<boolean>;
    hiddenAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    canvasHiddenAnnotationIds?: Ref<Set<string>> | ComputedRef<Set<string>> | undefined;
    managedAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<IPdfjsL10n | null>;
    replaceAnnotationUiManager: (manager: AnnotationEditorUIManager) => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    suppressSnap: () => void;
    beginSearchNavigation: (pageNumber: number) => void;
    revealSearchNavigationTarget: (
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => void;
    endSearchNavigation: (settleMs?: number) => void;
    beginSearchTransaction?: ((
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => number | null) | undefined;
    isSearchTransactionCurrent?: ((transactionId: number) => boolean) | undefined;
    settleSearchTransaction?: ((transactionId: number) => void) | undefined;
    cancelSearchTransaction?: ((transactionId: number) => void) | undefined;
    searchPageMatches: ComputedRef<Map<number, IPdfPageMatches>>;
    currentSearchMatch: ComputedRef<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: ComputedRef<number>;
    workingCopyPath: ComputedRef<string | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
    onRenderStall: (payload: IPageRenderStallPayload) => void;
    onPageCanvasMounted: (pageNumber: number) => void;
    onPageRendered: (pageNumber: number) => void;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
    isVisibleRenderRangeCurrent?: ((visibleRange: IPageRange) => boolean) | undefined;
    onRenderedPageStateChanged: () => void;
    renderedPageStateVersion: Ref<number>;
    pageSlots?: IPdfPageSlotRegistry | undefined;
    viewportWritePort: IPdfViewportWritePort;
}

export const usePdfViewerRenderingRuntime = (options: IUsePdfViewerRenderingRuntimeOptions) => {
    const rendering = usePdfPageRenderer({
        container: options.viewerContainer,
        document: options.document,
        currentPage: options.currentPage,
        isActive: options.isActive,
        effectiveScale: options.effectiveScale,
        outputScale: options.outputScale,
        rasterDisplayProfile: options.rasterDisplayProfile,
        bufferPages: options.bufferPages,
        showAnnotations: options.showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds,
        canvasHiddenAnnotationIds: options.canvasHiddenAnnotationIds,
        managedAnnotationIds: options.managedAnnotationIds,
        annotationUiManager: options.annotationUiManager,
        annotationL10n: options.annotationL10n,
        replaceAnnotationUiManager: options.replaceAnnotationUiManager,
        scrollToPage: options.scrollToPage,
        suppressSnap: options.suppressSnap,
        beginSearchNavigation: options.beginSearchNavigation,
        revealSearchNavigationTarget: options.revealSearchNavigationTarget,
        endSearchNavigation: options.endSearchNavigation,
        ...(options.beginSearchTransaction ? { beginSearchTransaction: options.beginSearchTransaction } : {}),
        ...(options.isSearchTransactionCurrent ? { isSearchTransactionCurrent: options.isSearchTransactionCurrent } : {}),
        ...(options.settleSearchTransaction ? { settleSearchTransaction: options.settleSearchTransaction } : {}),
        ...(options.cancelSearchTransaction ? { cancelSearchTransaction: options.cancelSearchTransaction } : {}),
        searchPageMatches: options.searchPageMatches,
        currentSearchMatch: options.currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId,
        workingCopyPath: options.workingCopyPath,
        documentRevisionToken: options.documentRevisionToken,
        viewportWritePort: options.viewportWritePort,
        onRenderStall: options.onRenderStall,
        onPageCanvasMounted: options.onPageCanvasMounted,
        onPageRendered: options.onPageRendered,
        onAnnotationLayersRendered: options.onAnnotationLayersRendered,
        isVisibleRenderRangeCurrent: options.isVisibleRenderRangeCurrent,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
        ...(options.pageSlots ? {pageSlots: options.pageSlots} : {}),
    });

    function cleanupRenderedPages() {
        rendering.cleanupAllPages();
        options.renderedPageStateVersion.value += 1;
    }

    function isPageRenderedForClass(page: number) {
        return options.renderedPageStateVersion.value >= 0 && rendering.isPageRendered(page);
    }

    function isPageFreshlyRenderedForNavigation(page: number) {
        return options.renderedPageStateVersion.value >= 0 && rendering.isPageFreshlyRendered(page);
    }

    return {
        ...rendering,
        cleanupRenderedPages,
        isPageFreshlyRenderedForNavigation,
        isPageRenderedForClass,
    };
};
