import type { Ref } from 'vue';
import type { IScrollSnapshot } from '@app/types/pdf';
import { captureScrollSnapshot } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/captureScrollSnapshot';
import { restoreScrollFromSnapshot } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/restoreScrollFromSnapshot';

export function usePdfViewerScrollSnapshot(options: {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    resolveHorizontalScrollClampForActiveSpread: () => { shouldLock: boolean } | null;
    syncHorizontalScrollForZoomMode: () => boolean;
    scrollToPage: (page: number) => void;
}) {
    function captureViewerScrollSnapshot() {
        return captureScrollSnapshot(options.viewerContainer.value, { preferredAnchorPage: options.currentPage.value });
    }

    function restoreViewerScrollSnapshot(
        snapshot: IScrollSnapshot | null,
        restoreOptions?: { fallbackPage?: number | null; },
    ) {
        const fallbackPage = typeof restoreOptions?.fallbackPage === 'number' && Number.isFinite(restoreOptions.fallbackPage)
            ? Math.max(1, Math.floor(restoreOptions.fallbackPage))
            : options.currentPage.value;
        const container = options.viewerContainer.value;

        if (snapshot && container && container.scrollWidth > 0 && container.scrollHeight > 0) {
            const scrollClamp = options.resolveHorizontalScrollClampForActiveSpread();
            restoreScrollFromSnapshot(container, snapshot, {
                restoreHorizontal: scrollClamp?.shouldLock !== true,
                restoreVertical: true,
                preferPageAnchor: true,
                allowVerticalRatioFallback: true,
            });
            options.syncHorizontalScrollForZoomMode();
            return;
        }

        options.scrollToPage(fallbackPage);
        options.syncHorizontalScrollForZoomMode();
    }

    return {
        captureViewerScrollSnapshot,
        restoreViewerScrollSnapshot,
    };
}
