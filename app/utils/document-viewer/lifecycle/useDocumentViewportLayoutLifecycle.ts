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

interface IUseDocumentViewportLayoutLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pageLayouts: Ref<readonly IDocumentZoomPageLayout[]>;
    captureRestoreEpoch: () => unknown;
    canRestore: (epoch: unknown) => boolean;
    applyRestoredScroll: (restored: {
        left: number;
        top: number;
    }) => void;
    isResizing?: Ref<boolean>;
    onResizeSettled?: () => void;
}

/**
 * Keeps a semantic page position stable while physical page geometry changes.
 *
 * A raw scroll offset is not document state: zoom, viewport resize, and
 * progressive page-metric discovery can all move the same page to a different
 * offset. This lifecycle owns that translation for every document renderer.
 */
export const useDocumentViewportLayoutLifecycle = (
    options: IUseDocumentViewportLayoutLifecycleOptions,
) => {
    let retainedAnchor: IDocumentZoomAnchor | null = null;
    let dragAnchor: IDocumentZoomAnchor | null = null;
    let layoutTransactionAnchor: IDocumentZoomAnchor | null = null;
    let layoutTransactionDepth = 0;
    let transitionGeneration = 0;
    let pendingRestore: {
        anchor: IDocumentZoomAnchor | null;
        epoch: unknown;
    } | null = null;
    let restoreScheduled = false;
    let disposed = false;
    let transitionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const isResizeTransitionActive = ref(false);

    const captureCurrentAnchor = () => {
        const container = options.viewerContainer.value;
        return container
            ? captureDocumentZoomAnchor(container, options.pageLayouts.value)
            : null;
    };

    const applyAnchor = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
        layouts = options.pageLayouts.value,
    ) => {
        const container = options.viewerContainer.value;
        if (!container || !options.canRestore(epoch)) {
            return false;
        }
        const restored = resolveDocumentZoomAnchorScroll(container, layouts, anchor);
        if (!restored) {
            return false;
        }
        options.applyRestoredScroll(restored);
        return true;
    };

    const scheduleAnchorRestore = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
    ) => {
        pendingRestore = {
            anchor,
            epoch,
        };
        if (restoreScheduled) {
            return;
        }
        restoreScheduled = true;
        void nextTick(() => {
            requestAnimationFrame(() => {
                restoreScheduled = false;
                const pending = pendingRestore;
                pendingRestore = null;
                if (disposed || !pending) {
                    return;
                }
                applyAnchor(layoutTransactionAnchor ?? pending.anchor, pending.epoch);
                if (!options.isResizing?.value) {
                    isResizeTransitionActive.value = false;
                    if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
                    transitionFallbackTimer = null;
                }
            });
        });
    };

    /**
     * Mutate layout inputs without exposing the viewport to an intermediate
     * raw-offset state. A post-paint replay accounts for DOM scroll clamping.
     */
    const preserveLayoutMutation = (mutate: () => void) => {
        const container = options.viewerContainer.value;
        const epoch = options.captureRestoreEpoch();
        const anchor = layoutTransactionAnchor ?? (
            container ? captureDocumentZoomAnchor(container, options.pageLayouts.value) : null
        );
        mutate();
        applyAnchor(anchor, epoch);
        scheduleAnchorRestore(anchor, epoch);
    };

    const beginLayoutTransaction = () => {
        layoutTransactionDepth += 1;
        if (layoutTransactionDepth === 1) {
            layoutTransactionAnchor = captureCurrentAnchor();
        }
    };

    const refreshLayoutTransactionAnchor = () => {
        const anchor = captureCurrentAnchor();
        retainedAnchor = anchor;
        if (layoutTransactionDepth > 0) {
            layoutTransactionAnchor = anchor;
        }
    };

    const endLayoutTransaction = async () => {
        if (layoutTransactionDepth === 0) {
            return;
        }
        layoutTransactionDepth -= 1;
        if (layoutTransactionDepth > 0) {
            return;
        }
        const epoch = options.captureRestoreEpoch();
        const anchor = layoutTransactionAnchor;
        await nextTick();
        applyAnchor(anchor, epoch);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        applyAnchor(anchor, epoch);
        retainedAnchor = anchor;
        layoutTransactionAnchor = null;
    };

    if (options.isResizing) {
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
                options.onResizeSettled?.();
                dragAnchor = null;
                transitionFallbackTimer = setTimeout(() => {
                    if (generation === transitionGeneration && !options.isResizing?.value) {
                        isResizeTransitionActive.value = false;
                    }
                    transitionFallbackTimer = null;
                }, 500);
            });
        }, {flush: 'sync'});
    }

    watch(options.pageLayouts, (layouts, previousLayouts) => {
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
        const anchor = layoutTransactionAnchor
            ?? dragAnchor
            ?? (isResizeTransitionActive.value ? retainedAnchor : null)
            ?? captureDocumentZoomAnchor(container, previousLayouts);
        scheduleAnchorRestore(anchor, epoch);
    }, {flush: 'post'});

    onScopeDispose(() => {
        disposed = true;
        pendingRestore = null;
        if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
    });

    return {
        beginLayoutTransaction,
        endLayoutTransaction,
        isResizeTransitionActive,
        preserveLayoutMutation,
        refreshLayoutTransactionAnchor,
    };
};
