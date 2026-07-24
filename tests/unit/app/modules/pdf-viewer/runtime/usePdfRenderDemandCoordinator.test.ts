import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import { usePdfRenderDemandCoordinator } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderDemandCoordinator';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { cast } from '@tests/helpers/cast';
import type { TPdfClampedVisibleRefineMode } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

interface ICreateHarnessOptions {
    clampedVisibleRefineMode?: TPdfClampedVisibleRefineMode;
    enableLayerPrewarm?: boolean;
}

function createHarness(options: ICreateHarnessOptions = {}) {
    const scope = effectScope();
    const visibleRange = ref({
        start: 43,
        end: 43,
    });
    const protectedVisibleRange = ref<{
        start: number;
        end: number;
    } | null>(null);
    const mountedPages = ref([
        43,
        44,
    ]);
    const pageSlots = createPdfPageSlotRegistry();
    const ready = new Set<number>();
    const layerReady = new Set<number>();
    const rendering = new Set<number>();
    const failureTokens = new Map<number, string>();
    const qualityRefineEligible = new Set<number>();
    const viewportInteractionEpoch = ref(0);
    const activeVisualTransaction = ref(false);
    const inputPending = ref(false);
    const renderStateVersion = ref(0);
    const renderGeneration = ref(1);
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const watchdogCallbacks = new Map<number, () => void>();
    const qualityRefineIdleCallbacks = new Map<number, {
        callback: () => void;
        delayMs: number;
    }>();
    let nextFrameId = 0;
    let nextWatchdogId = 0;
    let nextQualityRefineIdleId = 0;
    const renderVisiblePages = vi.fn(async () => undefined);
    const reconcilePageCanvasResidency = vi.fn();
    const coordinator = scope.run(() => usePdfRenderDemandCoordinator({
        visibleRange,
        getProtectedVisibleRange: () => protectedVisibleRange.value ?? visibleRange.value,
        pagesToRender: computed(() => mountedPages.value),
        bufferPages: computed(() => 4),
        ...(options.enableLayerPrewarm
            ? {
                viewMode: computed(() => 'single' as const),
                isPageLayerReady: (pageNumber: number) => layerReady.has(pageNumber),
            }
            : {}),
        maxBufferCanvasPixels: 100,
        estimatePageRasterPixels: () => 10,
        reconcilePageCanvasResidency,
        pageSlots,
        isActive: computed(() => true),
        isLoading: ref(false),
        pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
        numPages: ref(431),
        renderStateVersion,
        getRenderGeneration: () => renderGeneration.value,
        isPageReady: pageNumber => ready.has(pageNumber),
        isPageQualityRefineEligible: pageNumber => qualityRefineEligible.has(pageNumber),
        isPageRendering: pageNumber => rendering.has(pageNumber),
        getPageFailureToken: pageNumber => failureTokens.get(pageNumber) ?? null,
        clampedVisibleRefineMode: options.clampedVisibleRefineMode,
        getViewportInteractionEpoch: () => viewportInteractionEpoch.value,
        hasActiveVisualTransaction: () => activeVisualTransaction.value,
        isInputPending: () => inputPending.value,
        renderVisiblePages,
        requestFrame: callback => {
            nextFrameId += 1;
            frameCallbacks.set(nextFrameId, callback);
            return nextFrameId;
        },
        cancelFrame: frameId => {
            frameCallbacks.delete(frameId);
        },
        scheduleWatchdog: callback => {
            nextWatchdogId += 1;
            watchdogCallbacks.set(nextWatchdogId, callback);
            return nextWatchdogId;
        },
        cancelWatchdog: watchdogId => {
            watchdogCallbacks.delete(watchdogId as number);
        },
        scheduleQualityRefineIdle: (callback, delayMs) => {
            nextQualityRefineIdleId += 1;
            qualityRefineIdleCallbacks.set(nextQualityRefineIdleId, {
                callback,
                delayMs,
            });
            return nextQualityRefineIdleId;
        },
        cancelQualityRefineIdle: timerId => {
            qualityRefineIdleCallbacks.delete(timerId as number);
        },
    }));

    function flushFrame() {
        const entry = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
        if (!entry) {
            throw new Error('No render-demand frame is queued');
        }
        const [
            frameId,
            callback,
        ] = entry;
        frameCallbacks.delete(frameId);
        callback(0);
    }

    function flushWatchdog() {
        const entry = watchdogCallbacks.entries().next().value as [number, () => void] | undefined;
        if (!entry) {
            throw new Error('No render-demand watchdog is queued');
        }
        const [
            watchdogId,
            callback,
        ] = entry;
        watchdogCallbacks.delete(watchdogId);
        callback();
    }

    function flushQualityRefineIdle() {
        const entry = qualityRefineIdleCallbacks.entries().next().value as [
            number,
            {
                callback: () => void;
                delayMs: number
            },
        ] | undefined;
        if (!entry) {
            throw new Error('No quality-refine idle timer is queued');
        }
        const [
            timerId,
            timer,
        ] = entry;
        qualityRefineIdleCallbacks.delete(timerId);
        timer.callback();
    }

    return {
        activeVisualTransaction,
        coordinator,
        failureTokens,
        flushFrame,
        flushWatchdog,
        frameCallbacks,
        flushQualityRefineIdle,
        ready,
        layerReady,
        mountedPages,
        pageSlots,
        qualityRefineEligible,
        qualityRefineIdleCallbacks,
        renderStateVersion,
        renderGeneration,
        renderVisiblePages,
        reconcilePageCanvasResidency,
        rendering,
        scope,
        visibleRange,
        viewportInteractionEpoch,
        inputPending,
        protectedVisibleRange,
        watchdogCallbacks,
    };
}

describe('usePdfRenderDemandCoordinator', () => {
    it('keeps a cleared replacement target not ready while replacement demand retries', () => {
        const harness = createHarness();
        harness.pageSlots.markMounted(43);
        harness.failureTokens.set(43, '2:1');
        harness.renderStateVersion.value += 1;

        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('queued');
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({forceRerender: true}),
        );
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('queued');
        harness.scope.stop();
    });

    it('coalesces visible-range and mounted-slot signals into mandatory visible demand', () => {
        const harness = createHarness();
        harness.pageSlots.markMounted(43);
        harness.coordinator?.notifyPageMounted();
        harness.visibleRange.value = {
            start: 43,
            end: 44,
        };
        harness.pageSlots.markMounted(44);
        harness.coordinator?.notifyPageMounted();

        expect(harness.frameCallbacks.size).toBe(1);
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('queued');
        expect(harness.coordinator?.getPageVisualReadiness(44)).toBe('queued');

        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 44,
            },
            {
                bufferOverride: 0,
                coordinatorDemand: {
                    kind: 'required',
                    renderGeneration: 1,
                },
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
            },
        );
        harness.scope.stop();
    });

    it('supersedes a slow stale demand when the mounted visible range changes', () => {
        const harness = createHarness();
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<undefined>(() => {}));
        harness.pageSlots.markMounted(43);
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();

        harness.visibleRange.value = {
            start: 44,
            end: 44,
        };
        harness.pageSlots.markMounted(44);
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 44,
                end: 44,
            },
            {
                bufferOverride: 0,
                coordinatorDemand: {
                    kind: 'required',
                    renderGeneration: 1,
                },
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
            },
        );
        harness.scope.stop();
    });

    it('coalesces rapid authoritative fit requests and renders only the latest row', async () => {
        const harness = createHarness();
        const firstSettled = vi.fn();
        const firstRequest = harness.coordinator?.requestMandatoryRender({
            start: 43,
            end: 43,
        }, {forceRerender: true}).then(firstSettled);
        const secondRequest = harness.coordinator?.requestMandatoryRender({
            start: 44,
            end: 44,
        }, {forceRerender: true});

        await firstRequest;
        expect(firstSettled).toHaveBeenCalledOnce();
        expect(harness.frameCallbacks.size).toBe(1);

        harness.flushFrame();
        await secondRequest;
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 44,
                end: 44,
            },
            {
                bufferOverride: 0,
                forceRerender: true,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
            },
        );
        harness.scope.stop();
    });

    it('does not let automatic demand preempt or settle an active authoritative render', async () => {
        const harness = createHarness();
        let resolveAuthoritative!: (value: undefined) => void;
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            resolveAuthoritative = resolve;
        }));
        const authoritativeSettled = vi.fn();
        const authoritative = harness.coordinator?.requestMandatoryRender({
            start: 43,
            end: 43,
        }, {forceRerender: true}).then(authoritativeSettled);
        harness.flushFrame();

        harness.visibleRange.value = {
            start: 44,
            end: 44,
        };
        harness.pageSlots.markMounted(44);
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(authoritativeSettled).not.toHaveBeenCalled();

        resolveAuthoritative(undefined);
        await authoritative;
        expect(authoritativeSettled).toHaveBeenCalledOnce();
        expect(harness.frameCallbacks.size).toBe(1);
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 44,
                end: 44,
            },
            expect.objectContaining({bufferOverride: 0}),
        );
        harness.scope.stop();
    });

    it('keeps the authoritative navigation target resident until its visual transaction settles', async () => {
        const harness = createHarness();
        harness.pageSlots.markMounted(43);
        harness.pageSlots.markMounted(44);
        harness.ready.add(43);
        harness.protectedVisibleRange.value = {
            start: 44,
            end: 44,
        };
        harness.renderVisiblePages.mockImplementationOnce(async () => {
            harness.ready.add(44);
            // Canvas commit notifications are synchronous. Residency must use
            // the navigation target here, before the semantic visible range
            // is allowed to advance from page 43 to page 44.
            harness.renderStateVersion.value += 1;
        });

        const authoritative = harness.coordinator?.requestMandatoryRender({
            start: 44,
            end: 44,
        });
        harness.flushFrame();
        await authoritative;

        expect(harness.visibleRange.value).toEqual({
            start: 43,
            end: 43,
        });
        expect(harness.reconcilePageCanvasResidency).toHaveBeenLastCalledWith(
            expect.arrayContaining([44]),
            {
                start: 44,
                end: 44,
            },
        );
        harness.scope.stop();
    });

    it('starts a constrained jump target initial canvas before quiet-gated refinement', () => {
        const harness = createHarness({
            clampedVisibleRefineMode: 'input-idle',
            enableLayerPrewarm: true,
        });
        harness.pageSlots.markMounted(43);
        harness.pageSlots.markMounted(44);
        harness.ready.add(43);
        harness.layerReady.add(43);
        harness.protectedVisibleRange.value = {
            start: 44,
            end: 44,
        };
        harness.activeVisualTransaction.value = true;
        harness.inputPending.value = true;
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();

        expect(harness.visibleRange.value).toEqual({
            start: 43,
            end: 43,
        });
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 44,
                end: 44,
            },
            {
                bufferOverride: 0,
                coordinatorDemand: {
                    kind: 'required',
                    renderGeneration: 1,
                },
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
            },
        );
        expect(harness.qualityRefineIdleCallbacks.size).toBe(0);
        harness.scope.stop();
    });

    it('reasserts unsatisfied visible demand only through the bounded watchdog', async () => {
        const harness = createHarness();
        harness.pageSlots.markMounted(43);
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();
        await Promise.resolve();

        expect(harness.frameCallbacks.size).toBe(0);
        expect(harness.watchdogCallbacks.size).toBe(1);
        harness.flushWatchdog();
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);
        harness.scope.stop();
    });

    it('retries transient failures twice before exposing an explicit terminal error', async () => {
        const harness = createHarness();
        harness.pageSlots.markMounted(43);
        let failureRequestId = 0;
        harness.renderVisiblePages.mockImplementation(async () => {
            failureRequestId += 1;
            harness.failureTokens.set(43, `1:${String(failureRequestId)}`);
            harness.renderStateVersion.value += 1;
            return undefined;
        });
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();
        await Promise.resolve();
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('queued');
        harness.flushFrame();
        await Promise.resolve();
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('queued');
        harness.flushFrame();
        await Promise.resolve();

        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(3);
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('error');
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(3);
        expect(harness.frameCallbacks.size).toBe(0);
        harness.scope.stop();
    });

    it('renders only the viewport-centered raster window inside a larger mounted geometry window', async () => {
        const harness = createHarness();
        harness.mountedPages.value = [
            40,
            41,
            42,
            43,
            44,
            45,
            46,
        ];
        for (const pageNumber of harness.mountedPages.value) {
            harness.pageSlots.markMounted(pageNumber);
        }
        harness.ready.add(43);
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();
        await Promise.resolve();

        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            {
                contentIntent: 'canvas-only-buffer',
                coordinatorDemand: {
                    kind: 'buffer',
                    renderGeneration: 1,
                },
                maxCanvasPixels: 50,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                renderWindowOverride: {
                    start: 40,
                    end: 42,
                },
            },
        );
        expect(harness.reconcilePageCanvasResidency).toHaveBeenLastCalledWith(
            [
                43,
                44,
                42,
                45,
                41,
                46,
                40,
            ],
            {
                start: 43,
                end: 43,
            },
        );
        harness.scope.stop();
    });

    it('prewarms the immediate canvas-resident neighbor only after buffer demand drains', async () => {
        const harness = createHarness({enableLayerPrewarm: true});
        harness.pageSlots.markMounted(43);
        harness.pageSlots.markMounted(44);
        harness.ready.add(43);
        harness.ready.add(44);
        harness.layerReady.add(43);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();
        await Promise.resolve();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(1);
        expect(harness.renderVisiblePages).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            expect.objectContaining({contentIntent: 'canvas-only-buffer'}),
        );

        harness.flushFrame();
        await Promise.resolve();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 44,
                end: 44,
            },
            {
                bufferOverride: 0,
                contentIntent: 'layers-only-promotion',
                coordinatorDemand: {
                    kind: 'prewarm',
                    renderGeneration: 1,
                },
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                renderWindowOverride: {
                    start: 44,
                    end: 44,
                },
            },
        );
        harness.scope.stop();
    });

    it('promotes a visible canvas-only page before starting buffer work', () => {
        const harness = createHarness({enableLayerPrewarm: true});
        harness.pageSlots.markMounted(43);
        harness.pageSlots.markMounted(44);
        harness.ready.add(43);
        harness.ready.add(44);
        harness.layerReady.add(44);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({
                contentIntent: 'layers-only-promotion',
                coordinatorDemand: {
                    kind: 'required',
                    renderGeneration: 1,
                },
            }),
        );
        expect(harness.renderVisiblePages).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({contentIntent: 'canvas-only-buffer'}),
        );
        harness.scope.stop();
    });

    it('does not rasterize a far disjoint geometry segment outside the buffer radius', async () => {
        const harness = createHarness();
        harness.visibleRange.value = {
            start: 1,
            end: 1,
        };
        harness.mountedPages.value = [
            1,
            2,
            3,
            100,
            101,
            102,
        ];
        for (const pageNumber of harness.mountedPages.value) {
            harness.pageSlots.markMounted(pageNumber);
        }
        harness.ready.add(1);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();
        await Promise.resolve();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(1);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 1,
                end: 1,
            },
            expect.objectContaining({renderWindowOverride: {
                start: 2,
                end: 3,
            }}),
        );
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(1);
        expect(harness.renderVisiblePages).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({renderWindowOverride: {
                start: 100,
                end: 102,
            }}),
        );
        harness.scope.stop();
    });

    it('does not let a render-state signal preempt an active buffer range', async () => {
        const harness = createHarness();
        harness.visibleRange.value = {
            start: 43,
            end: 43,
        };
        harness.mountedPages.value = [
            42,
            43,
            44,
        ];
        for (const pageNumber of harness.mountedPages.value) {
            harness.pageSlots.markMounted(pageNumber);
        }
        harness.ready.add(43);
        let settleFirstBuffer!: (value: undefined) => void;
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            settleFirstBuffer = resolve;
        }));
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({renderWindowOverride: {
                start: 42,
                end: 42,
            }}),
        );

        // beginRender/commitCanvas update this version during a real buffer
        // render. Reconciliation must wait instead of starting page 44 with a
        // newer renderer request id and cancelling the first range.
        harness.renderStateVersion.value += 1;
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();

        settleFirstBuffer(undefined);
        await Promise.resolve();
        expect(harness.frameCallbacks.size).toBe(1);
        harness.flushFrame();
        await Promise.resolve();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({renderWindowOverride: {
                start: 44,
                end: 44,
            }}),
        );
        harness.scope.stop();
    });

    it('keeps rapid authoritative navigation latest-wins while a post-open buffer is active', async () => {
        const harness = createHarness();
        harness.visibleRange.value = {
            start: 43,
            end: 43,
        };
        harness.mountedPages.value = [
            43,
            44,
        ];
        harness.pageSlots.markMounted(43);
        harness.pageSlots.markMounted(44);
        harness.ready.add(43);
        let settleBuffer!: (value: undefined) => void;
        let settleFirstNavigation!: (value: undefined) => void;
        harness.renderVisiblePages
            .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
                settleBuffer = resolve;
            }))
            .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
                settleFirstNavigation = resolve;
            }));
        harness.coordinator?.notifyPageMounted();
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();

        const firstNavigationSettled = vi.fn();
        const firstNavigation = harness.coordinator?.requestMandatoryRender({
            start: 44,
            end: 44,
        }).then(firstNavigationSettled);
        harness.flushFrame();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(2);

        const supersededNavigationSettled = vi.fn();
        const supersededNavigation = harness.coordinator?.requestMandatoryRender({
            start: 45,
            end: 45,
        }).then(supersededNavigationSettled);
        const latestNavigation = harness.coordinator?.requestMandatoryRender({
            start: 46,
            end: 46,
        });
        await supersededNavigation;
        expect(supersededNavigationSettled).toHaveBeenCalledOnce();

        harness.flushFrame();
        await firstNavigation;
        expect(firstNavigationSettled).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledTimes(3);
        expect(harness.renderVisiblePages).toHaveBeenLastCalledWith(
            {
                start: 46,
                end: 46,
            },
            expect.objectContaining({
                bufferOverride: 0,
                preserveRenderedPages: true,
            }),
        );
        await latestNavigation;

        // Settling superseded work cannot steal active ownership or settle the
        // latest request. The interrupted post-open buffer remains queued.
        settleBuffer(undefined);
        settleFirstNavigation(undefined);
        await Promise.resolve();
        expect(harness.frameCallbacks.size).toBe(1);
        harness.scope.stop();
    });

    it('immediately refines one clamped visible buffer while preserving its committed canvas', () => {
        const harness = createHarness({clampedVisibleRefineMode: 'immediate'});
        harness.pageSlots.markMounted(43);
        harness.ready.add(43);
        harness.qualityRefineEligible.add(43);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({
                bufferOverride: 0,
                contentIntent: 'canvas-only-refine',
                forceRerender: true,
                preserveCommittedVisual: true,
            }),
        );
        expect(harness.coordinator?.getPageVisualReadiness(43)).toBe('ready');
        harness.scope.stop();
    });

    it('coalesces visible layer promotion with immediate quality refinement', () => {
        const harness = createHarness({
            clampedVisibleRefineMode: 'immediate',
            enableLayerPrewarm: true,
        });
        harness.mountedPages.value = [43];
        harness.pageSlots.markMounted(43);
        harness.ready.add(43);
        harness.qualityRefineEligible.add(43);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({
                contentIntent: 'full-visible',
                forceRerender: true,
                preserveCommittedVisual: true,
            }),
        );
        harness.scope.stop();
    });

    it('does not schedule quality work for an unclamped committed buffer', () => {
        const harness = createHarness({clampedVisibleRefineMode: 'immediate'});
        harness.mountedPages.value = [43];
        harness.pageSlots.markMounted(43);
        harness.ready.add(43);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();

        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        harness.scope.stop();
    });

    it('resets constrained refinement idle when viewport input advances', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const harness = createHarness({clampedVisibleRefineMode: 'input-idle'});
        harness.mountedPages.value = [43];
        harness.pageSlots.markMounted(43);
        harness.ready.add(43);
        harness.qualityRefineEligible.add(43);
        harness.coordinator?.notifyPageMounted();

        harness.flushFrame();
        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        expect([...harness.qualityRefineIdleCallbacks.values()][0]?.delayMs).toBe(160);

        vi.setSystemTime(1_159);
        harness.viewportInteractionEpoch.value += 1;
        harness.flushFrame();
        expect([...harness.qualityRefineIdleCallbacks.values()][0]?.delayMs).toBe(160);

        vi.setSystemTime(1_319);
        harness.flushQualityRefineIdle();
        harness.flushFrame();

        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 43,
                end: 43,
            },
            expect.objectContaining({preserveCommittedVisual: true}),
        );
        harness.scope.stop();
        vi.useRealTimers();
    });
});
