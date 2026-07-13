import type { Ref } from 'vue';
import type {
    IDocumentZoomAnchor,
    IDocumentZoomPageLayout,
} from '@app/utils/document-viewer/zoomAnchor';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
    resolveRetainedDocumentZoomAnchor,
} from '@app/utils/document-viewer/zoomAnchor';

interface IUseDocumentPageSourceResizeLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pageLayouts: Ref<readonly IDocumentZoomPageLayout[]>;
    isResizing: Ref<boolean>;
    captureRestoreEpoch: () => unknown;
    canRestore: (epoch: unknown) => boolean;
    applyRestoredScroll: (restored: {
        left: number;
        top: number;
    }) => void;
    onResizeSettled: () => void;
}

export const useDocumentPageSourceResizeLifecycle = (
    options: IUseDocumentPageSourceResizeLifecycleOptions,
) => {
    let retainedAnchor: IDocumentZoomAnchor | null = null;
    let dragAnchor: IDocumentZoomAnchor | null = null;
    let transitionGeneration = 0;
    let transitionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const isResizeTransitionActive = ref(false);

    watch(options.isResizing, (resizing, wasResizing) => {
        const container = options.viewerContainer.value;
        if (resizing) {
            transitionGeneration += 1;
            if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
            isResizeTransitionActive.value = true;
            dragAnchor = container
                ? resolveRetainedDocumentZoomAnchor(
                    container,
                    options.pageLayouts.value,
                    retainedAnchor,
                )
                : null;
            return;
        }
        if (!wasResizing) {
            return;
        }
        retainedAnchor = dragAnchor;
        const generation = transitionGeneration;
        void nextTick(() => {
            options.onResizeSettled();
            dragAnchor = null;
            transitionFallbackTimer = setTimeout(() => {
                if (generation === transitionGeneration && !options.isResizing.value) {
                    isResizeTransitionActive.value = false;
                }
                transitionFallbackTimer = null;
            }, 500);
        });
    }, {flush: 'sync'});

    watch(options.pageLayouts, async (layouts, previousLayouts) => {
        const container = options.viewerContainer.value;
        const epoch = options.captureRestoreEpoch();
        if (
            !container
            || layouts.length === 0
            || previousLayouts.length !== layouts.length
            || !options.canRestore(epoch)
        ) {
            return;
        }
        const anchor = dragAnchor
            ?? (isResizeTransitionActive.value ? retainedAnchor : null)
            ?? captureDocumentZoomAnchor(container, previousLayouts);
        await nextTick();
        if (!options.canRestore(epoch)) {
            return;
        }
        const restored = resolveDocumentZoomAnchorScroll(container, layouts, anchor);
        if (restored) {
            options.applyRestoredScroll(restored);
            const generation = transitionGeneration;
            requestAnimationFrame(() => {
                if (generation === transitionGeneration && !options.isResizing.value) {
                    isResizeTransitionActive.value = false;
                    if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
                    transitionFallbackTimer = null;
                }
            });
        }
    }, {flush: 'post'});

    onScopeDispose(() => {
        if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
    });
    return {isResizeTransitionActive};
};
