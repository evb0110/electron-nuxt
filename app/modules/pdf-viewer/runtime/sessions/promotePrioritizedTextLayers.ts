import type { IPageRange } from '@app/types/pdfUi';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

interface IPdfLayerPromotionRenderer {
    queuePrioritizedTextLayerPromotions: (
        pages: readonly number[],
        options: IRenderVisiblePagesOptions,
    ) => void;
    resolveLayerPromotionDemand: (pages: readonly number[]) => {
        range: IPageRange;
        options: IRenderVisiblePagesOptions;
    } | null;
    renderLayerPromotions: (
        range: IPageRange,
        options: IRenderVisiblePagesOptions,
    ) => Promise<void>;
}

export async function promotePrioritizedTextLayers(
    renderer: IPdfLayerPromotionRenderer,
    pages: readonly number[],
    renderOptions: IRenderVisiblePagesOptions,
) {
    if (renderOptions.prioritizeTextLayer !== true) {
        return;
    }
    const promotion = renderer.resolveLayerPromotionDemand(pages);
    if (!promotion) {
        renderer.queuePrioritizedTextLayerPromotions(pages, renderOptions);
        return;
    }
    await renderer.renderLayerPromotions(promotion.range, {
        ...promotion.options,
        prioritizeTextLayer: true,
    });
}
