import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { resolvePdfRasterResidencyPlan } from '@app/modules/pdf-viewer/runtime/rendering/resolvePdfRasterResidencyPlan';
import type { TPdfClampedVisibleRefineMode } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import type { TPdfViewMode } from '@contracts/shared';

type TPdfPageVisualReadiness = 'unmounted' | 'queued' | 'rendering' | 'ready' | 'error';

interface INavigatorScheduling {isInputPending: () => boolean;}

function hasNavigatorScheduling(
    value: Navigator,
): value is Navigator & {scheduling: INavigatorScheduling} {
    if (!('scheduling' in value)) {
        return false;
    }
    const scheduling = value.scheduling;
    return typeof scheduling === 'object'
        && scheduling !== null
        && 'isInputPending' in scheduling
        && typeof scheduling.isInputPending === 'function';
}

interface IUsePdfRenderDemandCoordinatorOptions {
    visibleRange: Ref<IPageRange>;
    getProtectedVisibleRange?: (() => IPageRange) | undefined;
    pagesToRender: ComputedRef<number[]>;
    bufferPages: ComputedRef<number>;
    viewMode?: ComputedRef<TPdfViewMode> | undefined;
    maxBufferCanvasPixels: number;
    estimatePageRasterPixels: (pageNumber: number) => number;
    pageSlots: IPdfPageSlotRegistry;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    renderStateVersion: Ref<number>;
    getRenderGeneration: () => number;
    suppressDemand?: Ref<boolean> | undefined;
    isPageReady: (pageNumber: number) => boolean;
    isPageQualityRefineEligible?: ((pageNumber: number) => boolean) | undefined;
    isPageLayerReady?: ((pageNumber: number) => boolean) | undefined;
    isPageRendering: (pageNumber: number) => boolean;
    getPageFailureToken: (pageNumber: number) => string | null;
    clampedVisibleRefineMode?: TPdfClampedVisibleRefineMode | undefined;
    getViewportInteractionEpoch?: (() => number) | undefined;
    hasActiveVisualTransaction?: (() => boolean) | undefined;
    isInputPending?: (() => boolean) | undefined;
    renderVisiblePages: (
        range: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
    cancelRasterDemand?: (() => void | Promise<void>) | undefined;
    requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
    cancelFrame?: ((frameId: number) => void) | undefined;
    scheduleQualityRefineIdle?: ((callback: () => void, delayMs: number) => unknown) | undefined;
    cancelQualityRefineIdle?: ((timerId: unknown) => void) | undefined;
    scheduleWatchdog?: ((callback: () => void) => unknown) | undefined;
    cancelWatchdog?: ((watchdogId: unknown) => void) | undefined;
}

interface IPdfViewportRasterPolicyOutput {
    bufferPages: readonly number[];
    requiredPages: readonly number[];
    residentPages: readonly number[];
    visibleRange: IPageRange;
}

export function resolvePdfViewportRasterPolicy(input: {
    bufferRadius: number;
    estimatePagePixels: (pageNumber: number) => number;
    maxBufferPixels: number;
    mountedPages: readonly number[];
    visibleRange: IPageRange;
}): IPdfViewportRasterPolicyOutput {
    const plan = resolvePdfRasterResidencyPlan({
        mountedPages: input.mountedPages,
        visibleRange: input.visibleRange,
        bufferRadius: input.bufferRadius,
        maxBufferPixels: input.maxBufferPixels,
        estimatePagePixels: input.estimatePagePixels,
    });
    const mountedPages = new Set(input.mountedPages);
    const requiredPages = plan.visiblePages.filter(pageNumber =>
        mountedPages.has(pageNumber));
    const bufferPages = plan.bufferPages.filter(pageNumber =>
        mountedPages.has(pageNumber));
    return {
        bufferPages,
        requiredPages,
        residentPages: [
            ...requiredPages,
            ...bufferPages,
        ],
        visibleRange: input.visibleRange,
    };
}

export const usePdfRenderDemandCoordinator = (
    options: IUsePdfRenderDemandCoordinatorOptions,
) => {
    const QUALITY_REFINE_INPUT_IDLE_MS = 160;
    const queuedPages = shallowRef(new Set<number>());
    const requestFrame = options.requestFrame
        ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame
        ?? ((frameId: number) => window.cancelAnimationFrame(frameId));
    const scheduleQualityRefineIdle = options.scheduleQualityRefineIdle
        ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
    const cancelQualityRefineIdle = options.cancelQualityRefineIdle
        ?? ((timerId: unknown) => window.clearTimeout(timerId as number));
    let frameId: number | null = null;
    let qualityRefineIdleTimer: unknown = null;
    let observedViewportInteractionEpoch = options.getViewportInteractionEpoch?.() ?? 0;
    let lastViewportInteractionAtMs = Date.now();
    let pendingMandatoryDemand: {
        options: IRenderVisiblePagesOptions;
        range: IPageRange;
        resolve: () => void;
    } | null = null;
    let disposed = false;

    function isOperational() {
        return !disposed
            && options.isActive.value
            && !options.isLoading.value
            && options.pdfDocument.value !== null
            && options.numPages.value > 0
            && options.suppressDemand?.value !== true;
    }

    function getClampedProtectedVisibleRange() {
        const requested = options.getProtectedVisibleRange?.() ?? options.visibleRange.value;
        const pageCount = Math.max(1, options.numPages.value);
        const start = Math.max(1, Math.min(pageCount, Math.trunc(requested.start)));
        return {
            start,
            end: Math.max(start, Math.min(pageCount, Math.trunc(requested.end))),
        };
    }

    function resolvePolicyOutput() {
        const visibleRange = getClampedProtectedVisibleRange();
        if (!isOperational()) {
            return {
                bufferPages: [],
                requiredPages: [],
                residentPages: [],
                visibleRange,
            } satisfies IPdfViewportRasterPolicyOutput;
        }
        return resolvePdfViewportRasterPolicy({
            mountedPages: options.pagesToRender.value.filter(
                pageNumber => options.pageSlots.isMounted(pageNumber),
            ),
            visibleRange,
            bufferRadius: options.bufferPages.value,
            maxBufferPixels: options.maxBufferCanvasPixels,
            estimatePagePixels: options.estimatePageRasterPixels,
        });
    }

    function publishQueuedPages(output = resolvePolicyOutput()) {
        queuedPages.value = new Set(output.requiredPages.filter(pageNumber => (
            !options.isPageReady(pageNumber)
            && !options.isPageRendering(pageNumber)
            && options.getPageFailureToken(pageNumber) === null
        )));
    }

    function clearQualityRefineIdleTimer() {
        if (qualityRefineIdleTimer === null) {
            return;
        }
        cancelQualityRefineIdle(qualityRefineIdleTimer);
        qualityRefineIdleTimer = null;
    }

    function synchronizeViewportInteractionEpoch() {
        const epoch = options.getViewportInteractionEpoch?.() ?? 0;
        if (epoch === observedViewportInteractionEpoch) {
            return;
        }
        observedViewportInteractionEpoch = epoch;
        lastViewportInteractionAtMs = Date.now();
        clearQualityRefineIdleTimer();
    }

    function hasPendingInput() {
        if (options.isInputPending) {
            return options.isInputPending();
        }
        return typeof navigator !== 'undefined'
            && hasNavigatorScheduling(navigator)
            && navigator.scheduling.isInputPending();
    }

    function canRefineVisibleRaster() {
        if ((options.clampedVisibleRefineMode ?? 'immediate') === 'immediate') {
            return true;
        }
        synchronizeViewportInteractionEpoch();
        const remainingIdleMs = QUALITY_REFINE_INPUT_IDLE_MS
            - (Date.now() - lastViewportInteractionAtMs);
        if (
            remainingIdleMs <= 0
            && options.hasActiveVisualTransaction?.() !== true
            && !hasPendingInput()
        ) {
            return true;
        }
        if (qualityRefineIdleTimer === null) {
            qualityRefineIdleTimer = scheduleQualityRefineIdle(() => {
                qualityRefineIdleTimer = null;
                queueFrame();
            }, Math.max(remainingIdleMs, QUALITY_REFINE_INPUT_IDLE_MS));
        }
        return false;
    }

    function queueFrame() {
        if (disposed || frameId !== null) {
            return;
        }
        frameId = requestFrame(() => {
            frameId = null;
            reconcile();
        });
    }

    function reconcile() {
        synchronizeViewportInteractionEpoch();
        if (!isOperational()) {
            queuedPages.value = new Set();
            pendingMandatoryDemand?.resolve();
            pendingMandatoryDemand = null;
            void options.cancelRasterDemand?.();
            return;
        }
        if (pendingMandatoryDemand) {
            const demand = pendingMandatoryDemand;
            pendingMandatoryDemand = null;
            void options.renderVisiblePages(demand.range, demand.options).then(
                demand.resolve,
                demand.resolve,
            );
            return;
        }
        const output = resolvePolicyOutput();
        publishQueuedPages(output);
        const missingRequiredPages = output.requiredPages.filter(
            pageNumber => !options.isPageReady(pageNumber),
        );
        if (missingRequiredPages.length > 0) {
            const forceRerender = missingRequiredPages.some(
                pageNumber => options.getPageFailureToken(pageNumber) !== null,
            );
            void options.renderVisiblePages(output.visibleRange, {
                bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: output.residentPages,
                ...(forceRerender ? {forceRerender: true} : {}),
            });
            return;
        }
        const layerPromotionPages = output.requiredPages.filter(
            pageNumber => options.isPageLayerReady?.(pageNumber) === false,
        );
        if (layerPromotionPages.length > 0) {
            const promotionRange = {
                start: Math.min(...layerPromotionPages),
                end: Math.max(...layerPromotionPages),
            };
            void options.renderVisiblePages(promotionRange, {
                bufferOverride: 0,
                contentIntent: 'layers-only-promotion',
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: layerPromotionPages,
                renderWindowOverride: promotionRange,
            });
            return;
        }
        const refinePage = output.requiredPages.find(
            pageNumber => options.isPageQualityRefineEligible?.(pageNumber) === true,
        );
        if (refinePage !== undefined && canRefineVisibleRaster()) {
            clearQualityRefineIdleTimer();
            void options.renderVisiblePages({
                start: refinePage,
                end: refinePage,
            }, {
                bufferOverride: 0,
                contentIntent: 'canvas-only-refine',
                forceRerender: true,
                preserveCommittedVisual: true,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: [refinePage],
            });
            return;
        }
        void options.renderVisiblePages(output.visibleRange, {
            bufferMaxCanvasPixels: options.maxBufferCanvasPixels,
            preserveInFlightRequiredPages: true,
            preserveRenderedPages: true,
            rasterDemandPages: output.residentPages,
        });
    }

    function scheduleReconcile() {
        publishQueuedPages();
        queueFrame();
    }

    function getPageVisualReadiness(pageNumber: number): TPdfPageVisualReadiness {
        if (!options.pageSlots.isMounted(pageNumber)) {
            return 'unmounted';
        }
        if (options.isPageReady(pageNumber)) {
            return 'ready';
        }
        if (options.getPageFailureToken(pageNumber) !== null) {
            return 'error';
        }
        if (options.isPageRendering(pageNumber)) {
            return 'rendering';
        }
        return 'queued';
    }

    function requestMandatoryRender(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions = {},
    ) {
        pendingMandatoryDemand?.resolve();
        return new Promise<void>((resolve) => {
            pendingMandatoryDemand = {
                options: {
                    ...renderOptions,
                    bufferOverride: renderOptions.bufferOverride ?? 0,
                    preserveInFlightRequiredPages:
                        renderOptions.preserveInFlightRequiredPages ?? true,
                    preserveRenderedPages: renderOptions.preserveRenderedPages ?? true,
                },
                range,
                resolve,
            };
            queueFrame();
        });
    }

    watch(
        () => [
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.pagesToRender.value.join(','),
            options.bufferPages.value,
            options.isActive.value,
            options.isLoading.value,
            Boolean(options.pdfDocument.value),
            options.numPages.value,
            options.suppressDemand?.value ?? false,
            options.getViewportInteractionEpoch?.() ?? 0,
            options.hasActiveVisualTransaction?.() ?? false,
        ] as const,
        scheduleReconcile,
        {
            flush: 'sync',
            immediate: true,
        },
    );
    watch(options.renderStateVersion, scheduleReconcile, {flush: 'sync'});

    onScopeDispose(() => {
        disposed = true;
        if (frameId !== null) {
            cancelFrame(frameId);
            frameId = null;
        }
        clearQualityRefineIdleTimer();
        queuedPages.value = new Set();
        pendingMandatoryDemand?.resolve();
        pendingMandatoryDemand = null;
        void options.cancelRasterDemand?.();
    });

    return {
        getPageVisualReadiness,
        notifyPageMounted: scheduleReconcile,
        notifyPageUnmounted: scheduleReconcile,
        notifyCanvasCommitted: scheduleReconcile,
        requestMandatoryRender,
        scheduleReconcile,
    };
};
