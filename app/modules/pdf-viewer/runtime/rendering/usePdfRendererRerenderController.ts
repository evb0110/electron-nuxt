import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { MaybeRefOrGetter } from 'vue';
import type { IPageRange } from '@app/types/pdfUi';
import { collectPreservedRenderPageNumbers } from '@app/modules/pdf-viewer/engine/pdf-page-render-preservation/collectPreservedRenderPageNumbers';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    normalizePdfRerenderSource,
    type TPdfRerenderSource,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type { IPdfPageNumberStateSet } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

interface IRerenderAllVisiblePagesOptions {
    preserveExistingPages?: boolean;
    rerenderSource?: TPdfRerenderSource;
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
    rerenderSource: TPdfRerenderSource;
    renderBufferOverride?: number;
    maxCanvasPixelsOverride?: number;
}

interface IUsePdfRendererRerenderControllerOptions {
    isActive: MaybeRefOrGetter<boolean>;
    renderedPages: IPdfPageNumberStateSet;
    staleRenderedPages: IPdfPageNumberStateSet;
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
}

export const usePdfRendererRerenderController = (options: IUsePdfRendererRerenderControllerOptions) => {
    const {
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
    } = options;

    function normalizeRerenderOptions(
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): INormalizedRerenderOptions {
        const {
            preserveExistingPages = false,
            rerenderSource,
            renderBufferOverride,
            maxCanvasPixelsOverride,
        } = rerenderOptions ?? {};

        const normalized: INormalizedRerenderOptions = {
            preserveExistingPages,
            rerenderSource: normalizePdfRerenderSource(rerenderSource),
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
        await renderMutex.acquire();

        try {
            if (getRenderVersion() !== version) {
                return;
            }

            if (preserveExistingPages) {
                pagesWithPreservedContent?.forEach(page => staleRenderedPages.add(page));

                setupPagePlaceholders();

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

    return reRenderAllVisiblePages;
};
