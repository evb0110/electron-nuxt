import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

type TPdfPageVisualReadiness = 'unmounted' | 'queued' | 'rendering' | 'ready' | 'error';

interface IUsePdfRenderDemandCoordinatorOptions {
    visibleRange: Ref<IPageRange>;
    pagesToRender: ComputedRef<number[]>;
    pageSlots: IPdfPageSlotRegistry;
    isActive: ComputedRef<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    renderStateVersion: Ref<number>;
    getRenderGeneration: () => number;
    suppressDemand?: Ref<boolean> | undefined;
    isPageReady: (pageNumber: number) => boolean;
    isPageRendering: (pageNumber: number) => boolean;
    getPageFailureToken: (pageNumber: number) => string | null;
    renderVisiblePages: (
        range: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
    requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
    cancelFrame?: ((frameId: number) => void) | undefined;
    scheduleWatchdog?: ((callback: () => void) => unknown) | undefined;
    cancelWatchdog?: ((watchdogId: unknown) => void) | undefined;
}

export const usePdfRenderDemandCoordinator = (options: IUsePdfRenderDemandCoordinatorOptions) => {
    const MAX_FAILURE_RETRIES = 2;
    const MAX_WATCHDOG_RECOVERIES = 2;
    const queuedPages = shallowRef(new Set<number>());
    const requestFrame = options.requestFrame
        ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame
        ?? ((frameId: number) => window.cancelAnimationFrame(frameId));
    const scheduleWatchdog = options.scheduleWatchdog
        ?? ((callback: () => void) => window.setTimeout(callback, 160));
    const cancelWatchdog = options.cancelWatchdog
        ?? ((watchdogId: unknown) => window.clearTimeout(watchdogId as number));
    let frameId: number | null = null;
    let watchdogId: unknown = null;
    let nextDemandId = 0;
    let activeDemand: {
        id: number;
        kind: 'automatic' | 'authoritative';
        signature: string;
        bufferRange?: IPageRange | undefined;
        resolve?: (() => void) | undefined;
    } | null = null;
    let nextAuthoritativeDemandId = 0;
    let pendingAuthoritativeDemand: {
        id: number;
        range: IPageRange;
        options: IRenderVisiblePagesOptions;
        resolve: () => void;
    } | null = null;
    let bufferDemandPending = true;
    let pendingBufferRanges: IPageRange[] = [];
    let automaticDemandPending = true;
    const watchdogRecoveries = new Map<string, number>();
    const observedFailureTokens = new Map<number, string>();
    const failureAttempts = new Map<number, number>();
    let observedRenderGeneration = options.getRenderGeneration();
    let disposed = false;

    function isOperational() {
        return !disposed
            && options.isActive.value
            && !options.isLoading.value
            && options.pdfDocument.value !== null
            && options.numPages.value > 0
            && options.suppressDemand?.value !== true;
    }

    function getClampedVisibleRange() {
        const pageCount = options.numPages.value;
        const start = Math.max(1, Math.min(pageCount, Math.trunc(options.visibleRange.value.start)));
        const end = Math.max(start, Math.min(pageCount, Math.trunc(options.visibleRange.value.end)));
        return {
            start,
            end,
        };
    }

    function getRequiredMountedPages() {
        if (!isOperational()) {
            return [];
        }
        const range = getClampedVisibleRange();
        const pages: number[] = [];
        for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
            if (options.pageSlots.isMounted(pageNumber)) {
                pages.push(pageNumber);
            }
        }
        return pages;
    }

    function getFailureAttempt(pageNumber: number) {
        if (options.isPageReady(pageNumber)) {
            observedFailureTokens.delete(pageNumber);
            failureAttempts.delete(pageNumber);
            return 0;
        }
        const token = options.getPageFailureToken(pageNumber);
        if (token === null) {
            return 0;
        }
        if (observedFailureTokens.get(pageNumber) !== token) {
            observedFailureTokens.set(pageNumber, token);
            failureAttempts.set(pageNumber, (failureAttempts.get(pageNumber) ?? 0) + 1);
        }
        return failureAttempts.get(pageNumber) ?? 0;
    }

    function isPageTerminalError(pageNumber: number) {
        return options.getPageFailureToken(pageNumber) !== null
            && getFailureAttempt(pageNumber) > MAX_FAILURE_RETRIES;
    }

    function needsRender(pageNumber: number) {
        return !options.isPageReady(pageNumber)
            && !options.isPageRendering(pageNumber)
            && !isPageTerminalError(pageNumber);
    }

    function publishQueuedRequiredPages() {
        const renderGeneration = options.getRenderGeneration();
        if (renderGeneration !== observedRenderGeneration) {
            observedRenderGeneration = renderGeneration;
            observedFailureTokens.clear();
            failureAttempts.clear();
            watchdogRecoveries.clear();
        }
        const nextQueued = new Set(
            getRequiredMountedPages().filter(pageNumber => needsRender(pageNumber)),
        );
        queuedPages.value = nextQueued;
    }

    function clearWatchdog(resetRecoveries: boolean) {
        if (watchdogId !== null) {
            cancelWatchdog(watchdogId);
            watchdogId = null;
        }
        if (resetRecoveries) {
            watchdogRecoveries.clear();
        }
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

    function scheduleReconcile(optionsOverride: {
        buffer?: boolean;
        resetWatchdog?: boolean;
    } = {}) {
        if (optionsOverride.buffer === true) {
            bufferDemandPending = true;
            pendingBufferRanges = [];
        }
        automaticDemandPending = true;
        clearWatchdog(optionsOverride.resetWatchdog === true);
        publishQueuedRequiredPages();
        queueFrame();
    }

    function partitionContiguousPages(pageNumbers: number[]) {
        const sortedPages = [...new Set(pageNumbers)].sort((left, right) => left - right);
        const ranges: IPageRange[] = [];
        for (const pageNumber of sortedPages) {
            const previous = ranges.at(-1);
            if (previous && pageNumber === previous.end + 1) {
                previous.end = pageNumber;
                continue;
            }
            ranges.push({
                start: pageNumber,
                end: pageNumber,
            });
        }
        return ranges;
    }

    function runNextBufferDemand() {
        const renderWindowOverride = pendingBufferRanges.shift();
        if (!renderWindowOverride) {
            return false;
        }
        automaticDemandPending = false;
        const visibleRange = getClampedVisibleRange();
        const bufferSignature = `buffer:${String(options.getRenderGeneration())}:${visibleRange.start}:${visibleRange.end}:${renderWindowOverride.start}:${renderWindowOverride.end}`;
        runDemand(
            bufferSignature,
            'automatic',
            visibleRange,
            {
                preserveRenderedPages: true,
                preserveInFlightRequiredPages: true,
                renderWindowOverride,
            },
            undefined,
            renderWindowOverride,
        );
        return true;
    }

    function runDemand(
        signature: string,
        kind: 'automatic' | 'authoritative',
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
        resolve?: (() => void) | undefined,
        bufferRange?: IPageRange | undefined,
    ) {
        if (activeDemand?.kind === 'authoritative') {
            if (kind === 'automatic') {
                return;
            }
            activeDemand.resolve?.();
        }
        if (kind === 'authoritative' && activeDemand?.kind === 'automatic' && activeDemand.bufferRange) {
            pendingBufferRanges.unshift(activeDemand.bufferRange);
        }
        if (
            kind === 'automatic'
            && bufferRange === undefined
            && activeDemand?.kind === 'automatic'
            && activeDemand.bufferRange
        ) {
            // Required visible demand may preempt a buffer render, but the
            // interrupted buffer range must remain pending. Buffer-to-buffer
            // demand is serialized below so a render-state notification from
            // page N cannot invalidate page N while starting page N + 1.
            pendingBufferRanges.unshift(activeDemand.bufferRange);
        }
        const demandId = ++nextDemandId;
        activeDemand = {
            id: demandId,
            kind,
            signature,
            ...(bufferRange ? {bufferRange} : {}),
            ...(resolve ? {resolve} : {}),
        };
        logPdfRenderTrace('render-demand-run-start', () => ({
            demandId,
            kind,
            signature,
            range,
            renderGeneration: options.getRenderGeneration(),
            queuedPages: [...queuedPages.value],
            pendingBufferRanges: [...pendingBufferRanges],
            hasPendingAuthoritativeDemand: pendingAuthoritativeDemand !== null,
            renderOptions,
        }));
        const settleDemand = () => {
            if (activeDemand?.id !== demandId) {
                logPdfRenderTrace('render-demand-run-settle', {
                    demandId,
                    kind,
                    signature,
                    outcome: 'superseded',
                });
                return;
            }
            activeDemand.resolve?.();
            activeDemand = null;
            logPdfRenderTrace('render-demand-run-settle', () => ({
                demandId,
                kind,
                signature,
                outcome: 'settled',
                queuedPages: [...queuedPages.value],
                pendingBufferRanges: [...pendingBufferRanges],
                automaticDemandPending,
            }));
            if (kind === 'authoritative') {
                if (pendingBufferRanges.length > 0) {
                    automaticDemandPending = true;
                }
                if (automaticDemandPending) {
                    queueFrame();
                }
                return;
            }
            publishQueuedRequiredPages();
            if (pendingBufferRanges.length > 0) {
                automaticDemandPending = true;
                queueFrame();
                return;
            }
            if (automaticDemandPending) {
                queueFrame();
                return;
            }
            if (queuedPages.value.size === 0) {
                return;
            }
            const recoveryCount = watchdogRecoveries.get(signature) ?? 0;
            if (recoveryCount >= MAX_WATCHDOG_RECOVERIES || watchdogId !== null) {
                return;
            }
            watchdogRecoveries.set(signature, recoveryCount + 1);
            watchdogId = scheduleWatchdog(() => {
                watchdogId = null;
                automaticDemandPending = true;
                queueFrame();
            });
        };
        logPdfRenderTrace('render-demand-renderer-invoke', {
            demandId,
            kind,
            signature,
            range,
            renderOptions,
        });
        void options.renderVisiblePages(range, renderOptions).then(settleDemand, settleDemand);
    }

    function reconcile() {
        publishQueuedRequiredPages();
        const operational = isOperational();
        logPdfRenderTrace('render-demand-reconcile', () => ({
            operational,
            disposed,
            isActive: options.isActive.value,
            isLoading: options.isLoading.value,
            hasPdfDocument: options.pdfDocument.value !== null,
            numPages: options.numPages.value,
            suppressDemand: options.suppressDemand?.value ?? false,
            renderGeneration: options.getRenderGeneration(),
            visibleRange: options.visibleRange.value,
            queuedPages: [...queuedPages.value],
            activeDemand: activeDemand
                ? {
                    id: activeDemand.id,
                    kind: activeDemand.kind,
                    signature: activeDemand.signature,
                }
                : null,
            pendingAuthoritativeDemand: pendingAuthoritativeDemand
                ? {
                    id: pendingAuthoritativeDemand.id,
                    range: pendingAuthoritativeDemand.range,
                }
                : null,
            automaticDemandPending,
            bufferDemandPending,
            pendingBufferRanges: [...pendingBufferRanges],
        }));
        if (!operational) {
            pendingAuthoritativeDemand?.resolve();
            pendingAuthoritativeDemand = null;
            return;
        }

        if (pendingAuthoritativeDemand) {
            const demand = pendingAuthoritativeDemand;
            pendingAuthoritativeDemand = null;
            runDemand(
                `authoritative:${String(options.getRenderGeneration())}:${String(demand.id)}`,
                'authoritative',
                demand.range,
                demand.options,
                demand.resolve,
            );
            return;
        }

        if (activeDemand?.kind === 'authoritative' || !automaticDemandPending) {
            return;
        }

        const requiredPages = [...queuedPages.value];
        if (requiredPages.length > 0) {
            const requiredSignature = `required:${String(options.getRenderGeneration())}:${requiredPages.join(',')}`;
            if (activeDemand?.signature === requiredSignature) {
                automaticDemandPending = false;
                return;
            }
            automaticDemandPending = false;
            const forceRerender = requiredPages.some(pageNumber => (
                options.getPageFailureToken(pageNumber) !== null
            ));
            runDemand(
                requiredSignature,
                'automatic',
                {
                    start: Math.min(...requiredPages),
                    end: Math.max(...requiredPages),
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                    ...(forceRerender ? {forceRerender: true} : {}),
                    preserveInFlightRequiredPages: true,
                },
            );
            return;
        }

        // An automatic buffer render owns the renderer request id until it
        // settles. Render-state notifications raised by that render schedule
        // reconciliation, but must not let the next buffer range supersede the
        // active one. A required visible range above can still preempt it.
        if (activeDemand !== null) {
            return;
        }

        if (pendingBufferRanges.length > 0) {
            runNextBufferDemand();
            return;
        }

        if (!bufferDemandPending) {
            automaticDemandPending = false;
            return;
        }
        if (getRequiredMountedPages().some(pageNumber => isPageTerminalError(pageNumber))) {
            bufferDemandPending = false;
            automaticDemandPending = false;
            return;
        }
        bufferDemandPending = false;
        automaticDemandPending = false;
        const mountedBufferPages = options.pagesToRender.value.filter(pageNumber => (
            options.pageSlots.isMounted(pageNumber)
        ));
        if (mountedBufferPages.length === 0) {
            return;
        }
        pendingBufferRanges = partitionContiguousPages(mountedBufferPages);
        runNextBufferDemand();
    }

    function getPageVisualReadiness(pageNumber: number): TPdfPageVisualReadiness {
        if (!options.pageSlots.isMounted(pageNumber)) {
            return 'unmounted';
        }
        if (options.isPageReady(pageNumber)) {
            return 'ready';
        }
        if (isPageTerminalError(pageNumber)) {
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
        pendingAuthoritativeDemand?.resolve();
        return new Promise<void>((resolve) => {
            const id = ++nextAuthoritativeDemandId;
            pendingAuthoritativeDemand = {
                id,
                range,
                options: {
                    ...renderOptions,
                    preserveRenderedPages: renderOptions.preserveRenderedPages ?? true,
                    bufferOverride: renderOptions.bufferOverride ?? 0,
                    preserveInFlightRequiredPages: renderOptions.preserveInFlightRequiredPages ?? true,
                },
                resolve,
            };
            logPdfRenderTrace('render-demand-authoritative-queued', () => ({
                id,
                range,
                renderGeneration: options.getRenderGeneration(),
                activeDemand: activeDemand
                    ? {
                        id: activeDemand.id,
                        kind: activeDemand.kind,
                        signature: activeDemand.signature,
                    }
                    : null,
                renderOptions: pendingAuthoritativeDemand?.options ?? renderOptions,
            }));
            queueFrame();
        });
    }

    watch(
        () => [
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.pagesToRender.value.join(','),
            options.isActive.value,
            options.isLoading.value,
            Boolean(options.pdfDocument.value),
            options.numPages.value,
            options.suppressDemand?.value ?? false,
        ] as const,
        () => scheduleReconcile({
            buffer: true,
            resetWatchdog: true,
        }),
        {
            flush: 'sync',
            immediate: true,
        },
    );
    watch(options.renderStateVersion, () => scheduleReconcile(), {flush: 'sync'});

    onScopeDispose(() => {
        disposed = true;
        if (frameId !== null) {
            cancelFrame(frameId);
            frameId = null;
        }
        clearWatchdog(true);
        queuedPages.value = new Set();
        pendingBufferRanges = [];
        pendingAuthoritativeDemand?.resolve();
        pendingAuthoritativeDemand = null;
        activeDemand?.resolve?.();
        activeDemand = null;
    });

    return {
        getPageVisualReadiness,
        notifyPageMounted: () => scheduleReconcile({
            buffer: true,
            resetWatchdog: true,
        }),
        notifyPageUnmounted: () => scheduleReconcile({
            buffer: true,
            resetWatchdog: true,
        }),
        notifyCanvasCommitted: () => scheduleReconcile(),
        requestMandatoryRender,
        scheduleReconcile,
    };
};
