import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { MaybeRefOrGetter } from 'vue';
import type { IPageRange } from '@app/types/pdfUi';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    normalizePdfRerenderSource,
    type TPdfRerenderSource,
} from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';

interface IRerenderAllVisiblePagesOptions {
    rerenderSource?: TPdfRerenderSource;
    renderBufferOverride?: number;
}

interface IRerenderAllVisiblePagesOptionsWithExplicitUndefined extends Omit<
    IRerenderAllVisiblePagesOptions,
    'renderBufferOverride'
> { renderBufferOverride?: number | undefined; }

interface INormalizedRerenderOptions {
    rerenderSource: TPdfRerenderSource;
    renderBufferOverride?: number;
}

interface IUsePdfRendererRerenderControllerOptions {
    isActive: MaybeRefOrGetter<boolean>;
    renderMutex: {
        acquire: () => Promise<void>;
        release: () => void;
    };
    getRenderVersion: () => number;
    bumpRenderVersion: (reason: string, payload?: Record<string, unknown>) => number;
    setupPagePlaceholders: () => void;
    renderVisiblePages: (visibleRange: IPageRange, options?: IRenderVisiblePagesOptions) => Promise<void>;
    requestMandatoryRender?: ((
        visibleRange: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>) | undefined;
    getTrackedPageNumbersForCleanup: () => Set<number>;
    clearPageVisual: (pageNumber: number) => boolean;
}

export const usePdfRendererRerenderController = (options: IUsePdfRendererRerenderControllerOptions) => {
    const {
        isActive,
        renderMutex,
        getRenderVersion,
        bumpRenderVersion,
        setupPagePlaceholders,
        renderVisiblePages,
        requestMandatoryRender,
        getTrackedPageNumbersForCleanup,
        clearPageVisual,
    } = options;

    function normalizeRerenderOptions(
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): INormalizedRerenderOptions {
        const {
            rerenderSource,
            renderBufferOverride,
        } = rerenderOptions ?? {};

        const normalized: INormalizedRerenderOptions = {rerenderSource: normalizePdfRerenderSource(rerenderSource)};
        if (renderBufferOverride !== undefined) {
            normalized.renderBufferOverride = renderBufferOverride;
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
        optionsOverride?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            preserveCommittedVisual?: boolean;
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
        await (requestMandatoryRender ?? renderVisiblePages)(visibleRange, renderOptions);
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
        const version = bumpRenderVersion('rerender-all-visible', {rerenderSource: normalizedOptions.rerenderSource ?? null});
        await renderMutex.acquire();

        try {
            if (getRenderVersion() !== version) {
                return;
            }

            // A committed page must never blank while its replacement raster is
            // still in flight (design §1.6 continuity invariant). Skip clearing
            // the currently visible pages: the forced re-render below carries
            // preserveCommittedVisual, so the single-page controller keeps each
            // mounted canvas on screen until its replacement commits, then swaps.
            // Off-screen tracked pages are still cleared to release residency.
            const clearVisibleRange = getVisibleRange();
            const pagesToCleanup = Array.from(getTrackedPageNumbersForCleanup());
            const preservedPages = pagesToCleanup.filter(
                page => page >= clearVisibleRange.start && page <= clearVisibleRange.end,
            );
            logPdfRenderTrace('renderer-rerender-full-cleanup', {
                version,
                rerenderSource: normalizedOptions.rerenderSource ?? null,
                pagesToCleanup,
                preservedPages,
            });
            pagesToCleanup
                .filter(page => page < clearVisibleRange.start || page > clearVisibleRange.end)
                .forEach(page => clearPageVisual(page));

            setupPagePlaceholders();

            await renderMountedVisiblePagesAfterRestore(
                version,
                getVisibleRange,
                normalizedOptions.renderBufferOverride,
                {
                    forceRerender: true,
                    preserveCommittedVisual: true,
                },
            );
        } finally {
            renderMutex.release();
        }
    }

    return reRenderAllVisiblePages;
};
