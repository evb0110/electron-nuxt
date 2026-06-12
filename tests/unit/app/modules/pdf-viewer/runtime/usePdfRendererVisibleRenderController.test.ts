import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfRendererVisibleRenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererVisibleRenderController';
import { cast } from '@tests/helpers/cast';

function createControllerHarness(options?: {
    activeRequestId?: number;
    renderingPageRequestId?: number;
}) {
    const renderVersion = 3;
    const activeRequestId = options?.activeRequestId ?? 7;
    const renderingPageRequestId = options?.renderingPageRequestId ?? activeRequestId;
    const renderingPages = new Map([[
        13,
        renderVersion,
    ]]);
    const renderingPageRequestIds = new Map([[
        13,
        renderingPageRequestId,
    ]]);
    const nextVisibleRenderRequestId = vi.fn(() => activeRequestId + 1);
    const ensurePageMetricsInRange = vi.fn(async () => true);
    const renderSingleVisiblePage = vi.fn(async () => undefined);
    const setupPagePlaceholders = vi.fn();
    const cancelObsoleteInFlightRenders = vi.fn();
    const cleanupPage = vi.fn();
    const scheduleMissingRenderTargetRetry = vi.fn();

    const controller = usePdfRendererVisibleRenderController({
        container: ref({} as HTMLElement),
        currentPage: ref(13),
        numPages: ref(20),
        isActive: true,
        bufferPages: 1,
        renderConcurrency: 3,
        effectiveScale: 1,
        renderedPages: new Set<number>(),
        staleRenderedPages: new Set<number>(),
        renderingPages,
        renderingPageRequestIds,
        getRenderVersion: () => renderVersion,
        getVisibleRenderRequestId: () => activeRequestId,
        nextVisibleRenderRequestId,
        ensurePageMetricsInRange,
        setupPagePlaceholders,
        cleanupPage,
        cancelObsoleteInFlightRenders,
        renderSingleVisiblePage,
        scheduleMissingRenderTargetRetry,
        throttleMs: 0,
    });

    return {
        controller,
        nextVisibleRenderRequestId,
        ensurePageMetricsInRange,
        renderSingleVisiblePage,
        setupPagePlaceholders,
        cancelObsoleteInFlightRenders,
    };
}

describe('usePdfRendererVisibleRenderController', () => {
    it('preserves an actively rendering required page without bumping the visible render request', async () => {
        const harness = createControllerHarness();

        await harness.controller.renderVisiblePages(
            {
                start: 13,
                end: 13,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 1,
                preserveInFlightRequiredPages: true,
            },
        );

        expect(harness.nextVisibleRenderRequestId).not.toHaveBeenCalled();
        expect(harness.ensurePageMetricsInRange).not.toHaveBeenCalled();
        expect(harness.cancelObsoleteInFlightRenders).not.toHaveBeenCalled();
        expect(harness.renderSingleVisiblePage).not.toHaveBeenCalled();
    });

    it('does not preserve stale in-flight bookkeeping from an older visible render request', async () => {
        const harness = createControllerHarness({
            activeRequestId: 7,
            renderingPageRequestId: 6,
        });

        await harness.controller.renderVisiblePages(
            {
                start: 13,
                end: 13,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 1,
                preserveInFlightRequiredPages: true,
            },
        );

        expect(harness.nextVisibleRenderRequestId).toHaveBeenCalledTimes(1);
        expect(harness.ensurePageMetricsInRange).toHaveBeenCalledWith(12, 14);
    });

    it('keeps visible pages while deferring buffer pages rejected by the render policy', async () => {
        const pageElement = cast<HTMLElement>({
            dataset: { page: '10' },
            querySelector: vi.fn(() => null),
        });
        const containerRoot = cast<HTMLElement>({
            querySelector: vi.fn((selector: string) => (
                selector === '.page_container[data-page="10"]'
                    ? pageElement
                    : null
            )),
            querySelectorAll: vi.fn(() => []),
        });
        let visibleRenderRequestId = 7;
        const renderSingleVisiblePage = vi.fn(async () => undefined);
        const controller = usePdfRendererVisibleRenderController({
            container: ref(containerRoot),
            currentPage: ref(10),
            numPages: ref(20),
            isActive: true,
            bufferPages: 1,
            renderConcurrency: 3,
            effectiveScale: 1,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map<number, number>(),
            renderingPageRequestIds: new Map<number, number>(),
            getRenderVersion: () => 3,
            getVisibleRenderRequestId: () => visibleRenderRequestId,
            nextVisibleRenderRequestId: () => {
                visibleRenderRequestId += 1;
                return visibleRenderRequestId;
            },
            ensurePageMetricsInRange: vi.fn(async () => true),
            setupPagePlaceholders: vi.fn(),
            cleanupPage: vi.fn(),
            cancelObsoleteInFlightRenders: vi.fn(),
            renderSingleVisiblePage,
            scheduleMissingRenderTargetRetry: vi.fn(),
            shouldRenderPage: (_pageNumber, context) => !context.isBufferPage,
            throttleMs: 0,
        });

        await controller.renderVisiblePages({
            start: 10,
            end: 10,
        });

        expect(renderSingleVisiblePage).toHaveBeenCalledTimes(1);
        expect(renderSingleVisiblePage).toHaveBeenCalledWith(
            containerRoot,
            10,
            expect.any(Number),
            expect.any(Number),
            expect.any(Boolean),
            expect.any(Number),
            expect.any(Function),
            new Set([10]),
            undefined,
        );
    });
});
