import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { IMarkerViewModel } from '@app/modules/pdf-viewer/engine/annotations/types';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IContentInsets,
    TPdfSource,
} from '@app/types/pdfUi';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IGuardAsyncOptions } from '@app/utils/asyncGuard';

interface IUsePdfRenderViewModelOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    viewerContainer: Ref<HTMLElement | null>;
    isVisualReloadTransitionActive: Ref<boolean>;
    suppressLoadingOverlay: ComputedRef<boolean>;
    /**
     * Current-page fit rerenders need exclusive ownership of the mounted row.
     *
     * In fit-height/fit-width paged mode, a rapid toolbar jump can cancel the
     * old PDF.js task, wait for it to unwind, and then force-render the target
     * page. If the ordinary paged buffer scheduler starts during that narrow
     * window, it can occupy the same large page proxy and leave the forced
     * current-page render stranded behind an infinitely visible skeleton.
     */
    suppressPagedBufferRender?: Ref<boolean> | undefined;
    skeletonContentInsets: Ref<IContentInsets | null>;
    pagesToRender: ComputedRef<number[]>;
    isPageBuffered: (page: number) => boolean;
    isPageRenderedForClass: (page: number) => boolean;
    isPageRendering: (page: number) => boolean;
    hasMountedPageCanvas: (page: number) => boolean;
    shouldShowSkeleton: (page: number) => boolean;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    pagedNavigationTargetPage?: ComputedRef<number | null> | Ref<number | null> | undefined;
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
        options: IRenderVisiblePagesOptions,
    ) => Promise<void>;
    runGuardedTask: (
        task: () => Promise<void>,
        options: IGuardAsyncOptions,
    ) => void;
}

const emptyLinksByPage: Record<number, never[]> = {};

export const usePdfRenderViewModel = (options: IUsePdfRenderViewModelOptions) => {
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
            return false;
        }
        if (options.isPageRenderedForClass(page)) {
            return false;
        }
        if (shouldBlockPageSkeletons.value) {
            return false;
        }
        if (options.hasMountedPageCanvas(page)) {
            return false;
        }
        return options.shouldShowSkeleton(page);
    }

    let pagedBufferRenderToken = 0;
    function isPagedBufferRenderSuppressed() {
        return options.suppressPagedBufferRender?.value === true;
    }

    function getPendingPagedTargetRenderRange(mountedPages: number[]) {
        if (options.continuousScroll.value) {
            return null;
        }

        const targetPage = options.pagedNavigationTargetPage?.value ?? null;
        if (targetPage === null) {
            return null;
        }

        const targetRowPages = mountedPages.filter(pageNumber => !options.isPageBuffered(pageNumber));
        if (!targetRowPages.includes(targetPage)) {
            return {
                start: targetPage,
                end: targetPage,
            };
        }

        return {
            start: Math.min(...targetRowPages),
            end: Math.max(...targetRowPages),
        };
    }

    function schedulePagedBufferRender() {
        const token = ++pagedBufferRenderToken;
        if (isPagedBufferRenderSuppressed()) {
            logPdfRenderTrace('paged-buffer-render-suppressed', {
                token,
                stage: 'schedule',
                currentPage: options.currentPage.value,
                visibleRange: {
                    start: options.visibleRange.value.start,
                    end: options.visibleRange.value.end,
                },
                pagesToRender: options.pagesToRender.value,
            });
            return;
        }
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
                || isPagedBufferRenderSuppressed()
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
                    suppressed: isPagedBufferRenderSuppressed(),
                });
                return;
            }

            const pendingTargetRange = getPendingPagedTargetRenderRange(mountedPages);
            const renderRange = pendingTargetRange ?? {
                start: firstMountedPage,
                end: lastMountedPage,
            };
            logPdfRenderTrace('paged-buffer-render-run', {
                token,
                currentPage: options.currentPage.value,
                firstMountedPage,
                lastMountedPage,
                renderRange,
                pendingTargetPage: options.pagedNavigationTargetPage?.value ?? null,
                visibleRange: {
                    start: options.visibleRange.value.start,
                    end: options.visibleRange.value.end,
                },
                mountedPages,
            });
            options.runGuardedTask(
                () => options.renderVisiblePages(
                    renderRange,
                    {
                        preserveRenderedPages: true,
                        bufferOverride: 0,
                        preserveInFlightRequiredPages: true,
                    },
                ),
                {
                    category: 'user-visible-operation',
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
        markPageRendered: (_pageNumber: number) => {},
    };
};
