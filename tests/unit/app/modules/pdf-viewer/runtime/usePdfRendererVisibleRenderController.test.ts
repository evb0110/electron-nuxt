import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfRendererVisibleRenderController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererVisibleRenderController';
import { BrowserLogger } from '@app/utils/browserLogger';
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

    const renderVisiblePages = usePdfRendererVisibleRenderController({
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
        renderVisiblePages,
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

        await harness.renderVisiblePages(
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

        await harness.renderVisiblePages(
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

    it('abandons stale visible ranges without warning or retrying missing containers', async () => {
        const currentVisibleRange = ref({
            start: 16,
            end: 16,
        });
        const scheduleMissingRenderTargetRetry = vi.fn();
        const warnSpy = vi.spyOn(BrowserLogger, 'warnThrottled').mockImplementation(() => {});
        const renderSingleVisiblePage = vi.fn(async () => undefined);
        const renderVisiblePages = usePdfRendererVisibleRenderController({
            container: ref(cast<HTMLElement>({
                querySelector: vi.fn(() => null),
                querySelectorAll: vi.fn(() => []),
            })),
            currentPage: ref(18),
            numPages: ref(392),
            isActive: true,
            bufferPages: 0,
            renderConcurrency: 1,
            effectiveScale: 1,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map<number, number>(),
            renderingPageRequestIds: new Map<number, number>(),
            getRenderVersion: () => 50,
            getVisibleRenderRequestId: () => 10,
            nextVisibleRenderRequestId: () => 10,
            ensurePageMetricsInRange: vi.fn(async () => true),
            setupPagePlaceholders: vi.fn(),
            cleanupPage: vi.fn(),
            cancelObsoleteInFlightRenders: vi.fn(),
            renderSingleVisiblePage,
            isVisibleRenderRangeCurrent: range => (
                currentVisibleRange.value.start === range.start
                && currentVisibleRange.value.end === range.end
            ),
            scheduleMissingRenderTargetRetry,
            throttleMs: 0,
        });

        const renderPromise = renderVisiblePages({
            start: 16,
            end: 16,
        });
        currentVisibleRange.value = {
            start: 18,
            end: 18,
        };
        await renderPromise;

        expect(warnSpy).not.toHaveBeenCalled();
        expect(scheduleMissingRenderTargetRetry).not.toHaveBeenCalled();
        expect(renderSingleVisiblePage).not.toHaveBeenCalled();

        warnSpy.mockRestore();
    });

    it('renders over-budget buffer pages clamped, forward neighbor first, and marks them stale', async () => {
        const resolveBufferPageCanvasClamp = vi.fn(() => ({
            maxCanvasPixels: 16_700_000,
            requestedPixels: 35_000_000,
        }));
        const harness = createBufferClampHarness({ resolveBufferPageCanvasClamp });

        await harness.renderVisiblePages({
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
        expect(harness.renderSingleVisiblePage.mock.calls[0]?.[9]).toBeUndefined();
        expect(harness.renderSingleVisiblePage.mock.calls[1]?.[9])
            .toEqual({ maxCanvasPixelsOverride: 16_700_000 });
        expect(harness.renderSingleVisiblePage.mock.calls[2]?.[9])
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

        await harness.renderVisiblePages({
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
            expect(call[9]).toBeUndefined();
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

        await harness.renderVisiblePages(
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
            expect(call[9]).toEqual({
                preserveRenderedPages: true,
                maxCanvasPixelsOverride: 14_000_000,
            });
        }
        expect(harness.staleRenderedPages.size).toBe(0);
    });

    it('uses a render-window override as buffer horizon while preserving the actual visible range', async () => {
        const resolveBufferPageCanvasClamp = vi.fn(() => null);
        const harness = createBufferClampHarness({
            pageNumbers: [
                10,
                11,
                12,
                13,
            ],
            resolveBufferPageCanvasClamp,
        });

        await harness.renderVisiblePages(
            {
                start: 10,
                end: 10,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
                renderWindowOverride: {
                    start: 10,
                    end: 13,
                },
                preserveInFlightRequiredPages: true,
            },
        );

        const renderedPageOrder = harness.renderSingleVisiblePage.mock.calls.map(call => call[1]);
        expect(renderedPageOrder).toEqual([
            10,
            11,
            12,
            13,
        ]);
        expect(harness.ensurePageMetricsInRange).toHaveBeenCalledWith(10, 13);
        expect(resolveBufferPageCanvasClamp).toHaveBeenCalledTimes(3);
        for (const call of harness.renderSingleVisiblePage.mock.calls) {
            expect(call[7]).toEqual(new Set([10]));
            expect(call[8]).toEqual({
                start: 10,
                end: 10,
            });
        }
    });
});

type TVisibleRenderControllerOptions = Parameters<typeof usePdfRendererVisibleRenderController>[0];

function createBufferClampHarness(options: {
    pageNumbers?: number[];
    resolveBufferPageCanvasClamp: NonNullable<TVisibleRenderControllerOptions['resolveBufferPageCanvasClamp']>;
}) {
    const pageNumbers = options.pageNumbers ?? [
        9,
        10,
        11,
    ];
    const pageElements = new Map<number, HTMLElement>(
        pageNumbers.map(pageNumber => [
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
    const ensurePageMetricsInRange = vi.fn(async () => true);
    const renderSingleVisiblePage = vi.fn<TVisibleRenderControllerOptions['renderSingleVisiblePage']>(
        async (_containerRoot, pageNumber) => {
            renderedPages.add(pageNumber);
        },
    );
    let visibleRenderRequestId = 7;

    const renderVisiblePages = usePdfRendererVisibleRenderController({
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
        ensurePageMetricsInRange,
        setupPagePlaceholders: vi.fn(),
        cleanupPage: vi.fn(),
        cancelObsoleteInFlightRenders: vi.fn(),
        renderSingleVisiblePage,
        scheduleMissingRenderTargetRetry: vi.fn(),
        resolveBufferPageCanvasClamp: options.resolveBufferPageCanvasClamp,
        throttleMs: 0,
    });

    return {
        renderVisiblePages,
        ensurePageMetricsInRange,
        renderSingleVisiblePage,
        renderedPages,
        staleRenderedPages,
    };
}
