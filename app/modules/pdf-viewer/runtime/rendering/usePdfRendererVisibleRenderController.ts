import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import type { IPageRange } from '@app/types/pdfUi';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

interface IUsePdfRendererLayerPromotionControllerOptions {
    container: Ref<HTMLElement | null>;
    effectiveScale: MaybeRefOrGetter<number>;
    isActive: MaybeRefOrGetter<boolean>;
    numPages: Ref<number>;
    renderConcurrency: MaybeRefOrGetter<number>;
    ensurePageMetricsInRange: (startPage: number, endPage: number) => Promise<boolean>;
    getRenderVersion: () => number;
    nextRequestId: (requested?: number) => number;
    setupPagePlaceholders: () => void;
    isRenderRequestCurrent?: ((request: IPdfViewerTransactionRenderRequest) => boolean) | undefined;
    isVisibleRenderRangeCurrent?: ((visibleRange: IPageRange) => boolean) | undefined;
    renderSingleVisiblePage: (
        containerRoot: HTMLElement,
        pageNumber: number,
        version: number,
        scale: number,
        forceRerender: boolean,
        requestId: number,
        shouldContinue: () => boolean,
        requiredPages: Set<number>,
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
}

export const usePdfRendererVisibleRenderController = (
    options: IUsePdfRendererLayerPromotionControllerOptions,
) => {
    let generation = 0;
    return async (
        visibleRange: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
    ) => {
        const containerRoot = options.container.value;
        if (!containerRoot || !toValue(options.isActive)) {
            return;
        }
        const activeGeneration = ++generation;
        const version = options.getRenderVersion();
        const requestId = options.nextRequestId(
            renderOptions.transactionRequest?.renderRequestId,
        );
        const pages = (renderOptions.rasterDemandPages
            ?? Array.from(
                {length: visibleRange.end - visibleRange.start + 1},
                (_, index) => visibleRange.start + index,
            ))
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= options.numPages.value);
        const didHydrateMetrics = await options.ensurePageMetricsInRange(
            visibleRange.start,
            visibleRange.end,
        );
        const shouldContinue = () => (
            activeGeneration === generation
            && version === options.getRenderVersion()
            && toValue(options.isActive)
            && options.isVisibleRenderRangeCurrent?.(visibleRange) !== false
            && (
                !renderOptions.transactionRequest
                || options.isRenderRequestCurrent?.(renderOptions.transactionRequest) !== false
            )
        );
        if (!shouldContinue()) {
            return;
        }
        if (didHydrateMetrics) {
            options.setupPagePlaceholders();
        }
        const requiredPages = new Set(pages);
        const concurrency = Math.max(1, Math.trunc(toValue(options.renderConcurrency)));
        for (let index = 0; index < pages.length; index += concurrency) {
            if (!shouldContinue()) {
                return;
            }
            await Promise.all(pages.slice(index, index + concurrency).map(pageNumber =>
                options.renderSingleVisiblePage(
                    containerRoot,
                    pageNumber,
                    version,
                    toValue(options.effectiveScale),
                    false,
                    requestId,
                    shouldContinue,
                    requiredPages,
                    visibleRange,
                    renderOptions,
                )));
        }
    };
};
