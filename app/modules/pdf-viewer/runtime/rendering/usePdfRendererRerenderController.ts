import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IPageRange } from '@app/utils/pdf-viewer/pdf-page-buffer-manager/pdfPageBufferManagerTypes';
import { captureScrollSnapshot } from '@app/utils/pdf-viewer/pdf-page-render-pipeline/captureScrollSnapshot';
import { collectPreservedRenderPageNumbers } from '@app/utils/pdf-viewer/pdf-page-render-preservation/collectPreservedRenderPageNumbers';
import { createPdfRerenderRestorationLogger } from '@app/utils/pdf-viewer/pdf-rerender-restoration/createPdfRerenderRestorationLogger';
import type { IRerenderRestorationContext } from '@app/utils/pdf-viewer/pdf-rerender-restoration/pdfRerenderRestorationTypes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IRerenderAllVisiblePagesOptions {
    preserveExistingPages?: boolean;
    anchorSnapshot?: IScrollSnapshot | null;
    disableHorizontalAnchorRestore?: boolean;
    disableVerticalAnchorRestore?: boolean;
    disablePageAnchorRestore?: boolean;
    rerenderSource?: string;
    renderBufferOverride?: number;
    maxCanvasPixelsOverride?: number;
}

interface IRerenderAllVisiblePagesOptionsWithExplicitUndefined extends Omit<
    IRerenderAllVisiblePagesOptions,
    'renderBufferOverride' | 'maxCanvasPixelsOverride'
> {
    renderBufferOverride?: number | undefined;
    maxCanvasPixelsOverride?: number | undefined;
}

interface INormalizedRerenderOptions {
    preserveExistingPages: boolean;
    anchorSnapshot: IScrollSnapshot | null;
    disableHorizontalAnchorRestore: boolean;
    disableVerticalAnchorRestore: boolean;
    disablePageAnchorRestore: boolean;
    rerenderSource: string;
    renderBufferOverride?: number;
    maxCanvasPixelsOverride?: number;
}

interface IRerenderRestoreContext extends INormalizedRerenderOptions, IRerenderRestorationContext {
    version: number;
    snapshotToRestore: IScrollSnapshot | null;
}

interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    forceRerender?: boolean;
    maxCanvasPixelsOverride?: number;
}

interface IUsePdfRendererRerenderControllerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    isActive: MaybeRefOrGetter<boolean>;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    pageCanvases: Map<number, HTMLCanvasElement>;
    renderMutex: {
        acquire: () => Promise<void>;
        release: () => void;
    };
    getRenderVersion: () => number;
    bumpRenderVersion: (reason: string, payload?: Record<string, unknown>) => number;
    setupPagePlaceholders: () => void;
    renderVisiblePages: (visibleRange: IPageRange, options?: IRenderVisiblePagesOptions) => Promise<void>;
    getTrackedPageNumbersForCleanup: () => Set<number>;
    cleanupPage: (pageNumber: number) => void;
    throttleMs: number;
}

export function usePdfRendererRerenderController(options: IUsePdfRendererRerenderControllerOptions) {
    const {
        container,
        currentPage,
        numPages,
        isActive,
        renderedPages,
        staleRenderedPages,
        pageCanvases,
        renderMutex,
        getRenderVersion,
        bumpRenderVersion,
        setupPagePlaceholders,
        renderVisiblePages,
        getTrackedPageNumbersForCleanup,
        cleanupPage,
        throttleMs,
    } = options;

    const {
        logRerenderSnapshotCapture,
        restoreScrollAndLog,
    } = createPdfRerenderRestorationLogger({
        container,
        currentPage,
        numPages,
        throttleMs,
    });

    function normalizeRerenderOptions(
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): INormalizedRerenderOptions {
        const {
            preserveExistingPages = false,
            anchorSnapshot = null,
            disableHorizontalAnchorRestore = false,
            disableVerticalAnchorRestore = false,
            disablePageAnchorRestore = false,
            rerenderSource = 'unknown',
            renderBufferOverride,
            maxCanvasPixelsOverride,
        } = rerenderOptions ?? {};

        const normalized: INormalizedRerenderOptions = {
            preserveExistingPages,
            anchorSnapshot,
            disableHorizontalAnchorRestore,
            disableVerticalAnchorRestore,
            disablePageAnchorRestore,
            rerenderSource,
        };
        if (renderBufferOverride !== undefined) {
            normalized.renderBufferOverride = renderBufferOverride;
        }
        if (maxCanvasPixelsOverride !== undefined) {
            normalized.maxCanvasPixelsOverride = maxCanvasPixelsOverride;
        }
        return normalized;
    }

    async function getMountedVisibleRangeAfterRestore(
        version: number,
        getVisibleRange: () => IPageRange,
    ) {
        await nextTick();
        if (getRenderVersion() !== version) {
            return null;
        }
        const range = getVisibleRange();
        await nextTick();
        if (getRenderVersion() !== version) {
            return null;
        }
        return range;
    }

    async function renderMountedVisiblePagesAfterRestore(
        version: number,
        getVisibleRange: () => IPageRange,
        renderBufferOverride: number | undefined,
        maxCanvasPixelsOverride: number | undefined,
        optionsOverride?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
        },
    ) {
        if (getRenderVersion() !== version) {
            return false;
        }

        const visibleRange = await getMountedVisibleRangeAfterRestore(version, getVisibleRange);
        if (visibleRange === null) {
            return false;
        }
        const renderOptions: IRenderVisiblePagesOptions = { ...optionsOverride };
        if (renderBufferOverride !== undefined) {
            renderOptions.bufferOverride = renderBufferOverride;
        }
        if (maxCanvasPixelsOverride !== undefined) {
            renderOptions.maxCanvasPixelsOverride = maxCanvasPixelsOverride;
        }
        await renderVisiblePages(visibleRange, renderOptions);
        return true;
    }

    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): Promise<void>;
    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptions,
    ): Promise<void>;
    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ) {
        if (!toValue(isActive)) {
            return;
        }
        const normalizedOptions = normalizeRerenderOptions(rerenderOptions);
        const { preserveExistingPages } = normalizedOptions;
        const pagesWithPreservedContent = preserveExistingPages
            ? collectPreservedRenderPageNumbers({
                renderedPages,
                pageCanvases,
            })
            : null;
        pagesWithPreservedContent?.forEach(page => staleRenderedPages.add(page));
        const version = bumpRenderVersion('rerender-all-visible', {
            preserveExistingPages,
            rerenderSource: normalizedOptions.rerenderSource ?? null,
        });
        const containerAtCapture = container.value;
        const snapshot = captureScrollSnapshot(containerAtCapture);
        const restoreContext: IRerenderRestoreContext = {
            ...normalizedOptions,
            version,
            snapshotToRestore: normalizedOptions.anchorSnapshot ?? snapshot,
        };

        logRerenderSnapshotCapture(
            version,
            preserveExistingPages,
            normalizedOptions.anchorSnapshot,
            snapshot,
            containerAtCapture,
        );

        await renderMutex.acquire();

        try {
            if (getRenderVersion() !== version) {
                return;
            }

            if (preserveExistingPages) {
                pagesWithPreservedContent?.forEach(page => staleRenderedPages.add(page));

                setupPagePlaceholders();

                if (getRenderVersion() === version) {
                    restoreScrollAndLog('preserve', restoreContext);
                }

                await renderMountedVisiblePagesAfterRestore(
                    version,
                    getVisibleRange,
                    normalizedOptions.renderBufferOverride,
                    normalizedOptions.maxCanvasPixelsOverride,
                    {
                        preserveRenderedPages: true,
                        forceRerender: true,
                    },
                );
                return;
            }

            const pagesToCleanup = Array.from(getTrackedPageNumbersForCleanup());
            logPdfRenderTrace('renderer-rerender-full-cleanup', {
                version,
                rerenderSource: normalizedOptions.rerenderSource ?? null,
                pagesToCleanup,
            });
            pagesToCleanup.forEach((page) => cleanupPage(page));

            setupPagePlaceholders();

            if (getRenderVersion() === version) {
                restoreScrollAndLog('full', restoreContext);
            }
            await renderMountedVisiblePagesAfterRestore(
                version,
                getVisibleRange,
                normalizedOptions.renderBufferOverride,
                normalizedOptions.maxCanvasPixelsOverride,
            );
        } finally {
            renderMutex.release();
        }
    }

    return {reRenderAllVisiblePages};
}
