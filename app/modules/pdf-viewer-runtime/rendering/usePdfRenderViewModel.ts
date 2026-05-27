import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { IMarkerViewModel } from '@app/composables/pdf/annotations/types';
import { usePdfViewerDelayedSkeleton } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerDelayedSkeleton';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerLoadingState';
import { PDF_VIEWER_PAGE_SKELETON_DELAY_MS } from '@app/constants/timeouts';
import { logPdfNav } from '@app/utils/pdfNavLog';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type {
    IContentInsets,
    PDFDocumentProxy,
    TFitMode,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import type { ILinkAnnotation } from '@app/types/annotations';

interface IUsePdfRenderViewModelOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    viewerContainer: Ref<HTMLElement | null>;
    isVisualReloadTransitionActive: Ref<boolean>;
    suppressLoadingOverlay: ComputedRef<boolean>;
    skeletonContentInsets: Ref<IContentInsets | null>;
    pagesToRender: ComputedRef<number[]>;
    isPageBuffered: (page: number) => boolean;
    isPageRenderedForClass: (page: number) => boolean;
    shouldShowSkeleton: (page: number) => boolean;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    currentPage: Ref<number>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    fitMode: ComputedRef<TFitMode>;
    effectiveScale: Ref<number>;
    continuousScroll: ComputedRef<boolean>;
    numPages: Ref<number>;
    markersByPage: Ref<Map<number, IMarkerViewModel[]>>;
    linksByPage: ComputedRef<Record<number, ILinkAnnotation[]>>;
    renderVisiblePages: (
        range: {
            start: number;
            end: number;
        },
        options: {
            preserveRenderedPages: true;
            bufferOverride: 0;
        },
    ) => Promise<void>;
    runGuardedTask: (
        task: () => Promise<void>,
        options: {
            scope: string;
            message: string;
        },
    ) => void;
}

const emptyLinksByPage: Record<number, never[]> = {};

export function usePdfRenderViewModel(options: IUsePdfRenderViewModelOptions) {
    const { isViewerLoadingOverlayVisible } = usePdfViewerLoadingState({
        src: options.src,
        isLoading: options.isLoading,
        pdfDocument: options.pdfDocument,
        viewerContainer: options.viewerContainer,
        holdOverlayVisible: options.isVisualReloadTransitionActive,
    });
    const isInitialSkeletonGeometryPending = computed(() => (
        Boolean(options.src.value)
        && Boolean(options.pdfDocument.value)
        && isViewerLoadingOverlayVisible.value
        && options.skeletonContentInsets.value === null
    ));
    const shouldBlockPageSkeletons = computed(() => (
        (
            isViewerLoadingOverlayVisible.value
            && options.isVisualReloadTransitionActive.value
            && !options.suppressLoadingOverlay.value
        )
        || options.suppressLoadingOverlay.value
        || isInitialSkeletonGeometryPending.value
    ));

    const delayedSkeleton = usePdfViewerDelayedSkeleton({
        delayMs: PDF_VIEWER_PAGE_SKELETON_DELAY_MS,
        trackedPages: options.pagesToRender,
        blockSkeletons: shouldBlockPageSkeletons,
        shouldShowSkeletonNow: options.shouldShowSkeleton,
    });

    const visibleMarkersByPage = computed(() => (
        new Map([...options.markersByPage.value].filter(([page]) => options.isPageRenderedForClass(page)))
    ));
    const visibleLinksByPage = computed(() => (
        isViewerLoadingOverlayVisible.value
            ? emptyLinksByPage
            : Object.fromEntries(
                Object.entries(options.linksByPage.value).filter(([page]) => options.isPageRenderedForClass(Number(page))),
            )
    ));

    function shouldShowPageSkeleton(page: number) {
        if (options.isPageBuffered(page)) {
            delayedSkeleton.hidePage(page);
            return false;
        }
        if (options.isPageRenderedForClass(page)) {
            delayedSkeleton.markPageRendered(page);
            return false;
        }
        const showSkeleton = delayedSkeleton.shouldShowSkeleton(page);
        const isVisiblePage = page >= options.visibleRange.value.start && page <= options.visibleRange.value.end;
        if (showSkeleton && isVisiblePage) {
            logPdfNav('[PDF-NAV] page skeleton visible', {
                page,
                currentPage: options.currentPage.value,
                visibleRange: `${options.visibleRange.value.start}-${options.visibleRange.value.end}`,
                pagesToRender: options.pagesToRender.value,
                rendered: options.isPageRenderedForClass(page),
                buffered: options.isPageBuffered(page),
                nearVisible: options.shouldShowSkeleton(page),
                delayMs: PDF_VIEWER_PAGE_SKELETON_DELAY_MS,
                zoom: options.zoom.value,
                zoomMode: options.zoomMode.value,
                fitMode: options.fitMode.value,
                effectiveScale: options.effectiveScale.value,
            });
        }
        return showSkeleton;
    }

    let pagedBufferRenderToken = 0;

    function schedulePagedBufferRender() {
        const token = ++pagedBufferRenderToken;
        logPdfRenderTrace('paged-buffer-render-scheduled', {
            token,
            currentPage: options.currentPage.value,
            visibleRange: {
                start: options.visibleRange.value.start,
                end: options.visibleRange.value.end,
            },
            pagesToRender: options.pagesToRender.value,
        });
        void nextTick(() => {
            const mountedPages = options.pagesToRender.value;
            const firstMountedPage = mountedPages[0];
            const lastMountedPage = mountedPages[mountedPages.length - 1];
            if (
                token !== pagedBufferRenderToken
                || options.continuousScroll.value
                || options.isLoading.value
                || !options.pdfDocument.value
                || options.numPages.value <= 0
                || firstMountedPage === undefined
                || lastMountedPage === undefined
            ) {
                logPdfRenderTrace('paged-buffer-render-skipped', {
                    token,
                    activeToken: pagedBufferRenderToken,
                    continuousScroll: options.continuousScroll.value,
                    isLoading: options.isLoading.value,
                    hasDocument: Boolean(options.pdfDocument.value),
                    mountedPages,
                    firstMountedPage,
                    lastMountedPage,
                });
                return;
            }

            logPdfRenderTrace('paged-buffer-render-run', {
                token,
                currentPage: options.currentPage.value,
                firstMountedPage,
                lastMountedPage,
                visibleRange: {
                    start: options.visibleRange.value.start,
                    end: options.visibleRange.value.end,
                },
                mountedPages,
            });
            options.runGuardedTask(
                () => options.renderVisiblePages(
                    {
                        start: firstMountedPage,
                        end: lastMountedPage,
                    },
                    {
                        preserveRenderedPages: true,
                        bufferOverride: 0,
                    },
                ),
                {
                    scope: 'pdf-viewer',
                    message: 'Failed to pre-render paged navigation buffer',
                },
            );
        });
    }

    watch(
        () => [
            options.continuousScroll.value,
            options.isLoading.value,
            Boolean(options.pdfDocument.value),
            options.numPages.value,
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.pagesToRender.value.join(','),
        ] as const,
        () => {
            if (!options.continuousScroll.value) {
                schedulePagedBufferRender();
            }
        },
        { flush: 'post' },
    );

    return {
        isViewerLoadingOverlayVisible,
        visibleMarkersByPage,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        markPageRendered: delayedSkeleton.markPageRendered,
    };
}
