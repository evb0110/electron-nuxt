import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IL10n } from 'pdfjs-dist/types/web/interfaces';
import type { IScrollToPageOptions } from '@app/composables/pdf/usePdfScroll';
import {
    usePdfPageRenderingController,
    type IPageRenderStallPayload,
} from '@app/modules/pdf-viewer-runtime/rendering/usePdfPageRenderingController';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';

interface IUsePdfViewerRenderingRuntimeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    document: Parameters<typeof usePdfPageRenderingController>[0]['document'];
    currentPage: Ref<number>;
    isActive: ComputedRef<boolean>;
    effectiveScale: ComputedRef<number>;
    bufferPages: ComputedRef<number>;
    showAnnotations: ComputedRef<boolean>;
    hiddenAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    managedAnnotationIds: Ref<Set<string>> | ComputedRef<Set<string>>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<IL10n | null>;
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
    onRenderedPageStateChanged: () => void;
    renderedPageStateVersion: Ref<number>;
}

export function usePdfViewerRenderingRuntime(options: IUsePdfViewerRenderingRuntimeOptions) {
    const rendering = usePdfPageRenderingController({
        container: options.viewerContainer,
        document: options.document,
        currentPage: options.currentPage,
        isActive: options.isActive,
        effectiveScale: options.effectiveScale,
        bufferPages: options.bufferPages,
        showAnnotations: options.showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds,
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
        onRenderedPageStateChanged: options.onRenderedPageStateChanged,
    });

    function cleanupRenderedPages() {
        rendering.cleanupAllPages();
        options.renderedPageStateVersion.value += 1;
    }

    function hasMountedPageCanvas(page: number) {
        const container = options.viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${page}"]`,
        );
        return Boolean(container?.querySelector('.page_canvas canvas'));
    }

    function isPageRenderedForClass(page: number) {
        return options.renderedPageStateVersion.value >= 0 && hasMountedPageCanvas(page);
    }

    return {
        ...rendering,
        cleanupRenderedPages,
        isPageRenderedForClass,
    };
}
