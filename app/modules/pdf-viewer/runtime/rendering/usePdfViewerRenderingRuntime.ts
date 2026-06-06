import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { IScrollToPageOptions } from '@app/composables/pdf/usePdfScroll';
import { usePdfPageRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {
    IPageRenderStallPayload,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';

interface IUsePdfViewerRenderingRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    document: IUsePdfPageRendererOptions['document'];
    currentPage: Ref<number>;
    isActive: ComputedRef<boolean>;
    effectiveScale: ComputedRef<number>;
    bufferPages: ComputedRef<number>;
    showAnnotations: ComputedRef<boolean>;
    hiddenAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    canvasHiddenAnnotationIds?: Ref<Set<string>> | ComputedRef<Set<string>> | undefined;
    managedAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<IPdfjsL10n | null>;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    suppressSnap: () => void;
    beginSearchNavigation: (pageNumber: number) => void;
    endSearchNavigation: (settleMs?: number) => void;
    searchPageMatches: ComputedRef<Map<number, IPdfPageMatches>>;
    currentSearchMatch: ComputedRef<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId: ComputedRef<number>;
    workingCopyPath: ComputedRef<string | null>;
    onRenderStall: (payload: IPageRenderStallPayload) => void;
    onPageCanvasMounted: (pageNumber: number) => void;
    onPageRendered: (pageNumber: number) => void;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
    onRenderedPageStateChanged: () => void;
    renderedPageStateVersion: Ref<number>;
}

export function usePdfViewerRenderingRuntime(options: IUsePdfViewerRenderingRuntimeOptions) {
    const rendering = usePdfPageRenderer({
        container: options.viewerContainer,
        document: options.document,
        currentPage: options.currentPage,
        isActive: options.isActive,
        effectiveScale: options.effectiveScale,
        bufferPages: options.bufferPages,
        showAnnotations: options.showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds,
        canvasHiddenAnnotationIds: options.canvasHiddenAnnotationIds,
        managedAnnotationIds: options.managedAnnotationIds,
        annotationUiManager: options.annotationUiManager,
        annotationL10n: options.annotationL10n,
        scrollToPage: options.scrollToPage,
        suppressSnap: options.suppressSnap,
        beginSearchNavigation: options.beginSearchNavigation,
        endSearchNavigation: options.endSearchNavigation,
        searchPageMatches: options.searchPageMatches,
        currentSearchMatch: options.currentSearchMatch,
        currentSearchMatchNavigationId: options.currentSearchMatchNavigationId,
        workingCopyPath: options.workingCopyPath,
        onRenderStall: options.onRenderStall,
        onPageCanvasMounted: options.onPageCanvasMounted,
        onPageRendered: options.onPageRendered,
        onAnnotationLayersRendered: options.onAnnotationLayersRendered,
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
    });

    function cleanupRenderedPages() {
        rendering.cleanupAllPages();
        options.renderedPageStateVersion.value += 1;
    }

    function isPageRenderedForClass(page: number) {
        return options.renderedPageStateVersion.value >= 0 && rendering.isPageRendered(page);
    }

    return {
        ...rendering,
        cleanupRenderedPages,
        isPageRenderedForClass,
    };
}
