import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { IMarkerViewModel } from '@app/modules/pdf-viewer/engine/annotations/types';
import { usePdfViewerDelayedSkeleton } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerDelayedSkeleton';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import { PDF_VIEWER_PAGE_SKELETON_DELAY_MS } from '@app/constants/timeouts';
import { logPdfNav } from '@app/utils/logPdfNav';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type {
    IContentInsets,
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import type { ILinkAnnotation } from '@app/types/annotations';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

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
    skeletonTrackedPages?: ComputedRef<number[]> | undefined;
    isPageBuffered: (page: number) => boolean;
    isPageRenderedForClass: (page: number) => boolean;
    isPageRendering: (page: number) => boolean;
    hasMountedPageCanvas: (page: number) => boolean;
    shouldShowSkeletonImmediately?: ((page: number) => boolean) | undefined;
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
    isPagedNavigationBurstActive?: (() => boolean) | undefined;
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
        options: {
            scope: string;
            message: string;
        },
    ) => void;
}

const emptyLinksByPage: Record<number, never[]> = {};
const PAGED_BUFFER_RENDER_QUIET_DELAY_MS = 220;

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

    const skeletonTrackedPages = computed(() => (
        options.skeletonTrackedPages?.value ?? options.pagesToRender.value
    ));

    const delayedSkeleton = usePdfViewerDelayedSkeleton({
        delayMs: PDF_VIEWER_PAGE_SKELETON_DELAY_MS,
        trackedPages: skeletonTrackedPages,
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
        if (shouldBlockPageSkeletons.value) {
            delayedSkeleton.hidePage(page);
            return false;
        }
        if (options.shouldShowSkeletonImmediately?.(page) === true) {
            delayedSkeleton.hidePage(page);
            return true;
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
                rendering: options.isPageRendering(page),
                hasMountedCanvas: options.hasMountedPageCanvas(page),
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
    let pagedBufferRenderQuietTimer: ReturnType<typeof setTimeout> | null = null;

    function isPagedBufferRenderSuppressed() {
        return options.suppressPagedBufferRender?.value === true;
    }

    function clearPagedBufferQuietTimer() {
        if (!pagedBufferRenderQuietTimer) {
            return;
        }

        clearTimeout(pagedBufferRenderQuietTimer);
        pagedBufferRenderQuietTimer = null;
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
            if (options.isPagedNavigationBurstActive?.() === true) {
                clearPagedBufferQuietTimer();
                pagedBufferRenderQuietTimer = setTimeout(() => {
                    pagedBufferRenderQuietTimer = null;
                    if (token === pagedBufferRenderToken) {
                        schedulePagedBufferRender();
                    }
                }, PAGED_BUFFER_RENDER_QUIET_DELAY_MS);
                logPdfRenderTrace('paged-buffer-render-deferred-for-navigation-burst', {
                    token,
                    currentPage: options.currentPage.value,
                    mountedPages,
                });
                return;
            }

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

    watch(
        () => options.pdfDocument.value,
        () => {
            clearPagedBufferQuietTimer();
        },
    );

    onScopeDispose(() => {
        clearPagedBufferQuietTimer();
    });

    return {
        isViewerLoadingOverlayVisible,
        visibleMarkersByPage,
        visibleLinksByPage,
        shouldShowPageSkeleton,
        markPageRendered: delayedSkeleton.markPageRendered,
    };
};
