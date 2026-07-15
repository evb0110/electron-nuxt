import type { Ref } from 'vue';
import {
    isThumbnailRasterWidthReady,
    resolveThumbnailRasterWidth,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';

interface IUsePdfThumbnailRasterReadinessOptions {
    cancelActiveRenders: () => void;
    cancelPendingRender: () => void;
    clearThumbnailCanvas: (page: number, canvas: HTMLCanvasElement) => void;
    incrementRenderGeneration: () => void;
    layoutWidth: Ref<number>;
    renderWidth: Ref<number>;
    resolveOutputScale: () => number;
    resolveVisibleContainer: (reason: string) => HTMLElement | null;
    scheduleRender: () => void;
}

export const usePdfThumbnailRasterReadiness = (
    options: IUsePdfThumbnailRasterReadinessOptions,
) => {
    function isReady() {
        return isThumbnailRasterWidthReady(
            options.layoutWidth.value,
            options.renderWidth.value,
        );
    }

    function clearVisibleCanvases(pages: number[] | null = null) {
        const container = options.resolveVisibleContainer('clear-visible-thumbnails');
        if (!container) {
            return;
        }

        const pageFilter = pages ? new Set(pages) : null;
        for (const thumbnail of container.querySelectorAll<HTMLElement>('.pdf-thumbnail')) {
            const page = Number(thumbnail.dataset.page);
            if (pageFilter && !pageFilter.has(page)) {
                continue;
            }
            const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
            if (canvas) {
                options.clearThumbnailCanvas(page, canvas);
            }
        }
    }

    function clearUnderResolutionCanvases() {
        const container = options.resolveVisibleContainer('clear-under-resolution-thumbnails');
        if (!container) {
            return;
        }

        const minimumPixelWidth = Math.ceil(
            resolveThumbnailRasterWidth(options.layoutWidth.value) * options.resolveOutputScale(),
        );
        for (const thumbnail of container.querySelectorAll<HTMLElement>('.pdf-thumbnail')) {
            const page = Number(thumbnail.dataset.page);
            const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
            const isPresented = canvas?.dataset.thumbnailRendered === 'true'
                || canvas?.dataset.thumbnailPreservedBitmap === 'true';
            if (canvas && isPresented && canvas.width < minimumPixelWidth) {
                options.clearThumbnailCanvas(page, canvas);
            }
        }
    }

    function resolveMinimumRenderPixelWidth() {
        return Math.ceil(options.renderWidth.value * options.resolveOutputScale());
    }

    watch(
        () => [
            options.layoutWidth.value,
            options.renderWidth.value,
        ] as const,
        () => {
            if (isReady()) {
                options.scheduleRender();
                return;
            }
            options.cancelPendingRender();
            options.cancelActiveRenders();
            options.incrementRenderGeneration();
            clearUnderResolutionCanvases();
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    return {
        clearUnderResolutionCanvases,
        clearVisibleCanvases,
        isReady,
        resolveMinimumRenderPixelWidth,
    };
};
