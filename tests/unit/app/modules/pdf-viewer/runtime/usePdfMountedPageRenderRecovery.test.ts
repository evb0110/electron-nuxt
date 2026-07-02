import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import { usePdfMountedPageRenderRecovery } from '@app/modules/pdf-viewer/runtime/rendering/usePdfMountedPageRenderRecovery';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

async function flushTimersAndTicks() {
    await vi.runOnlyPendingTimersAsync();
    await nextTick();
    await Promise.resolve();
}

function createHarness(options?: {
    isPageMounted?: ((pageNumber: number) => boolean) | undefined;
    onSupervisorEvent?: ((event: IPdfRenderSupervisorEvent) => void) | undefined;
    suppressRecovery?: Ref<boolean>;
}) {
    const scope = effectScope();
    const isActive = ref(true);
    const isLoading = ref(false);
    const hasDocument = ref(true);
    const suppressRecovery = options?.suppressRecovery ?? ref(false);
    const numPages = ref(928);
    const pagesNeedingRender = ref(new Set<number>());
    const renderVisiblePages = vi.fn(async () => {});
    const renderSupervisor = options?.onSupervisorEvent
        ? createPdfRenderSupervisor({ onEvent: options.onSupervisorEvent })
        : undefined;
    const recovery = scope.run(() => usePdfMountedPageRenderRecovery({
        isActive: computed(() => isActive.value),
        isLoading,
        hasDocument: computed(() => hasDocument.value),
        numPages,
        suppressRecovery,
        isPageMounted: options?.isPageMounted,
        shouldRecoverPage: pageNumber => pagesNeedingRender.value.has(pageNumber),
        renderVisiblePages,
        renderSupervisor,
    }));

    if (!recovery) {
        throw new Error('Failed to create mounted page render recovery harness');
    }

    return {
        hasDocument,
        isActive,
        isLoading,
        numPages,
        pagesNeedingRender,
        recovery,
        renderVisiblePages,
        suppressRecovery,
        scope,
    };
}

describe('usePdfMountedPageRenderRecovery', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders a late-mounted visible page with no canvas', async () => {
        vi.useFakeTimers();
        const supervisorEvents: IPdfRenderSupervisorEvent[] = [];
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ onSupervisorEvent: event => supervisorEvents.push(event) });
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 928,
                end: 928,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                preserveInFlightRequiredPages: true,
            },
        );
        expect(supervisorEvents).toContainEqual(expect.objectContaining({
            cause: 'mounted-page-recovery',
            metadata: expect.objectContaining({
                pendingPages: [928],
                runId: 0,
            }),
        }));

        scope.stop();
    });

    it('retries after the first recovery render leaves the mounted page unrendered', async () => {
        vi.useFakeTimers();
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness();
        pagesNeedingRender.value = new Set([928]);
        renderVisiblePages.mockImplementation(async () => {
            if (renderVisiblePages.mock.calls.length >= 2) {
                pagesNeedingRender.value = new Set();
            }
        });

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();
        expect(renderVisiblePages).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(159);
        expect(renderVisiblePages).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await nextTick();
        expect(renderVisiblePages).toHaveBeenCalledTimes(2);

        scope.stop();
    });

    it('does not queue recovery while the document is unavailable', async () => {
        vi.useFakeTimers();
        const {
            hasDocument,
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness();
        hasDocument.value = false;
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();

        expect(renderVisiblePages).not.toHaveBeenCalled();

        scope.stop();
    });

    it('does not render a newly mounted page while recovery is suppressed', async () => {
        vi.useFakeTimers();
        const suppressRecovery = ref(true);
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ suppressRecovery });
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();

        expect(renderVisiblePages).not.toHaveBeenCalled();

        scope.stop();
    });

    it('renders a pending mounted page after recovery suppression is released', async () => {
        vi.useFakeTimers();
        const suppressRecovery = ref(true);
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ suppressRecovery });
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();
        expect(renderVisiblePages).not.toHaveBeenCalled();

        suppressRecovery.value = false;
        await nextTick();
        await flushTimersAndTicks();

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 928,
                end: 928,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                preserveInFlightRequiredPages: true,
            },
        );

        scope.stop();
    });

    it('keeps a pending page when suppression starts before its retry timer fires', async () => {
        vi.useFakeTimers();
        const suppressRecovery = ref(false);
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ suppressRecovery });
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        suppressRecovery.value = true;
        await flushTimersAndTicks();
        expect(renderVisiblePages).not.toHaveBeenCalled();

        suppressRecovery.value = false;
        await nextTick();
        await flushTimersAndTicks();

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 928,
                end: 928,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                preserveInFlightRequiredPages: true,
            },
        );

        scope.stop();
    });

    it('keeps a pending page when suppression starts during an active recovery render', async () => {
        vi.useFakeTimers();
        const suppressRecovery = ref(false);
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ suppressRecovery });
        pagesNeedingRender.value = new Set([928]);
        renderVisiblePages.mockImplementation(async () => {
            suppressRecovery.value = true;
        });

        recovery.queueMountedPageRender(928);
        await flushTimersAndTicks();
        expect(renderVisiblePages).toHaveBeenCalledTimes(1);

        suppressRecovery.value = false;
        await nextTick();
        await flushTimersAndTicks();

        expect(renderVisiblePages).toHaveBeenCalledTimes(2);

        scope.stop();
    });

    it('drops a pending page that unmounts before recovery exhausts', async () => {
        vi.useFakeTimers();
        const mountedPages = ref(new Set([928]));
        const warnSpy = vi.spyOn(BrowserLogger, 'warnThrottled').mockImplementation(() => {});
        const {
            pagesNeedingRender,
            recovery,
            renderVisiblePages,
            scope,
        } = createHarness({ isPageMounted: pageNumber => mountedPages.value.has(pageNumber) });
        pagesNeedingRender.value = new Set([928]);

        recovery.queueMountedPageRender(928);
        mountedPages.value = new Set();
        await flushTimersAndTicks();
        await vi.runAllTimersAsync();

        expect(renderVisiblePages).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalledWith(
            'pdf-renderer',
            'mounted-page-render-recovery-exhausted:928',
            expect.any(Number),
            expect.any(String),
            expect.any(Object),
        );

        warnSpy.mockRestore();
        scope.stop();
    });

    it('renders the resolved visible row for a late-mounted row sibling', async () => {
        vi.useFakeTimers();
        const scope = effectScope();
        const renderVisiblePages = vi.fn(async () => {});
        const pagesNeedingRender = ref(new Set([4]));
        const recovery = scope.run(() => usePdfMountedPageRenderRecovery({
            isActive: computed(() => true),
            isLoading: ref(false),
            hasDocument: computed(() => true),
            numPages: ref(10),
            shouldRecoverPage: pageNumber => pagesNeedingRender.value.has(pageNumber),
            resolveRecoveryRange: () => ({
                start: 3,
                end: 4,
            }),
            renderVisiblePages,
        }));

        if (!recovery) {
            throw new Error('Failed to create mounted page render recovery harness');
        }

        recovery.queueMountedPageRender(4);
        await flushTimersAndTicks();

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 3,
                end: 4,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                preserveInFlightRequiredPages: true,
            },
        );

        scope.stop();
    });
});
