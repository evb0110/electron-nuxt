import type {Ref} from 'vue';
import type {TPdfRenderingSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type {TPdfViewportSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {runGuardedTask} from '@app/utils/asyncGuard';

export function createPdfAnnotationOwnershipRefreshWatch(options: {
    documentSession: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    rendering: TPdfRenderingSession;
    storeOwnedPdfAnnotationIds: Ref<ReadonlySet<string>>;
    nextTick: () => Promise<void>;
}) {
    let refreshQueued = false;
    let refreshRunning = false;

    function scheduleRefresh() {
        refreshQueued = true;
        if (refreshRunning) {
            return;
        }

        refreshRunning = true;
        runGuardedTask(async () => {
            try {
                while (refreshQueued) {
                    refreshQueued = false;
                    await options.nextTick();
                    if (!options.documentSession.pdfDocument.value) {
                        continue;
                    }
                    const range = options.viewport.visibleRange.value;
                    if (range.start > range.end) {
                        continue;
                    }
                    await options.rendering.renderVisiblePages(range, {
                        preserveRenderedPages: true,
                        forceRerender: true,
                        bufferOverride: 0,
                    });
                }
            } finally {
                refreshRunning = false;
                if (refreshQueued) {
                    scheduleRefresh();
                }
            }
        }, {
            category: 'background-diagnostic',
            scope: 'pdf-annotations',
            message: 'Failed to refresh PDF annotation ownership projection',
        });
    }

    return watch(
        options.storeOwnedPdfAnnotationIds,
        scheduleRefresh,
        {
            flush: 'post',
            immediate: true,
        },
    );
}
