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

    it('renders over-budget buffer pages clamped, forward neighbor first, and marks them stale', async () => {
        const resolveBufferPageCanvasClamp = vi.fn(() => ({
            maxCanvasPixels: 16_700_000,
            requestedPixels: 35_000_000,
        }));
        const harness = createBufferClampHarness({ resolveBufferPageCanvasClamp });

        await harness.controller.renderVisiblePages({
            start: 10,
            end: 10,
        });

        const renderedPageOrder = harness.renderSingleVisiblePage.mock.calls.map(call => call[1]);
        expect(renderedPageOrder).toEqual([
            10,
            11,
            9,
        ]);
        expect(resolveBufferPageCanvasClamp).toHaveBeenCalledTimes(2);
        expect(harness.renderSingleVisiblePage.mock.calls[0]?.[8]).toBeUndefined();
        expect(harness.renderSingleVisiblePage.mock.calls[1]?.[8])
            .toEqual({ maxCanvasPixelsOverride: 16_700_000 });
        expect(harness.renderSingleVisiblePage.mock.calls[2]?.[8])
            .toEqual({ maxCanvasPixelsOverride: 16_700_000 });
        expect(harness.staleRenderedPages).toEqual(new Set([
            9,
            11,
        ]));
        expect(harness.renderedPages).toEqual(new Set([
            9,
            10,
            11,
        ]));
    });

    it('renders within-budget buffer pages unclamped without stale marking', async () => {
        const harness = createBufferClampHarness({ resolveBufferPageCanvasClamp: () => null });

        await harness.controller.renderVisiblePages({
            start: 10,
            end: 10,
        });

        const renderedPageOrder = harness.renderSingleVisiblePage.mock.calls.map(call => call[1]);
        expect(renderedPageOrder).toEqual([
            10,
            11,
            9,
        ]);
        for (const call of harness.renderSingleVisiblePage.mock.calls) {
            expect(call[8]).toBeUndefined();
        }
        expect(harness.staleRenderedPages.size).toBe(0);
    });

    it('passes explicit max-canvas overrides through untouched when the resolver declines', async () => {
        const harness = createBufferClampHarness({resolveBufferPageCanvasClamp: (_pageNumber, context) => (
            context.renderOptions?.maxCanvasPixelsOverride !== undefined
                ? null
                : {
                    maxCanvasPixels: 8_400_000,
                    requestedPixels: 20_000_000,
                }
        )});

        await harness.controller.renderVisiblePages(
            {
                start: 10,
                end: 10,
            },
            {
                preserveRenderedPages: true,
                maxCanvasPixelsOverride: 14_000_000,
            },
        );

        for (const call of harness.renderSingleVisiblePage.mock.calls) {
            expect(call[8]).toEqual({
                preserveRenderedPages: true,
                maxCanvasPixelsOverride: 14_000_000,
            });
        }
        expect(harness.staleRenderedPages.size).toBe(0);
    });
});

type TVisibleRenderControllerOptions = Parameters<typeof usePdfRendererVisibleRenderController>[0];

function createBufferClampHarness(options: {resolveBufferPageCanvasClamp: NonNullable<TVisibleRenderControllerOptions['resolveBufferPageCanvasClamp']>;}) {
    const pageElements = new Map<number, HTMLElement>(
        [
            9,
            10,
            11,
        ].map(pageNumber => [
            pageNumber,
            cast<HTMLElement>({
                dataset: { page: String(pageNumber) },
                querySelector: vi.fn(() => null),
            }),
        ]),
    );
    const containerRoot = cast<HTMLElement>({
        querySelector: vi.fn((selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            return pageElements.get(Number.parseInt(match[1], 10)) ?? null;
        }),
        querySelectorAll: vi.fn(() => []),
    });
    const renderedPages = new Set<number>();
    const staleRenderedPages = new Set<number>();
    const renderSingleVisiblePage = vi.fn<TVisibleRenderControllerOptions['renderSingleVisiblePage']>(
        async (_containerRoot, pageNumber) => {
            renderedPages.add(pageNumber);
        },
    );
    let visibleRenderRequestId = 7;

    const controller = usePdfRendererVisibleRenderController({
        container: ref(containerRoot),
        currentPage: ref(10),
        numPages: ref(20),
        isActive: true,
        bufferPages: 1,
        renderConcurrency: 3,
        effectiveScale: 1,
        renderedPages,
        staleRenderedPages,
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
        resolveBufferPageCanvasClamp: options.resolveBufferPageCanvasClamp,
        throttleMs: 0,
    });

    return {
        controller,
        renderSingleVisiblePage,
        renderedPages,
        staleRenderedPages,
    };
}
