// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { createPagePreviewCache } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import {
    PAGE_PREVIEW_TARGET_PRIORITY,
    createPagePreviewRenderQueue,
} from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewRenderQueue';
import { cast } from '@tests/helpers/cast';

interface IRenderControl {
    promise: Promise<void>;
    resolve: () => void;
}

function flushAsync() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createQueueHarness(options?: { concurrency?: number; }) {
    const cache = createPagePreviewCache({ maxEntries: 24 });
    const renderControls = new Map<number, IRenderControl>();
    const startedRenders: number[] = [];

    function ensureRenderControl(pageNumber: number) {
        const existing = renderControls.get(pageNumber);
        if (existing) {
            return existing;
        }

        let resolveRender!: () => void;
        const promise = new Promise<void>((resolve) => {
            resolveRender = resolve;
        });
        const control = {
            promise,
            resolve: resolveRender,
        };
        renderControls.set(pageNumber, control);
        return control;
    }

    const queue = createPagePreviewRenderQueue({
        cache,
        getPage: async pageNumber => cast<PDFPageProxy>({
            getViewport: () => ({
                width: 100,
                height: 100,
            }),
            render: () => {
                startedRenders.push(pageNumber);
                return { promise: ensureRenderControl(pageNumber).promise };
            },
        }),
        maxLongestSidePx: 768,
        concurrency: options?.concurrency ?? 2,
    });

    async function resolveRender(pageNumber: number) {
        ensureRenderControl(pageNumber).resolve();
        await flushAsync();
    }

    return {
        cache,
        queue,
        startedRenders,
        resolveRender,
    };
}

describe('createPagePreviewRenderQueue', () => {
    beforeEach(() => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue(cast<CanvasRenderingContext2D>({}));
        vi.stubGlobal('createImageBitmap', undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('reserves a lane for target renders so prefetches never occupy both slots', async () => {
        const harness = createQueueHarness({ concurrency: 2 });

        harness.queue.ensurePages([
            {
                pageNumber: 1,
                priority: 50,
            },
            {
                pageNumber: 2,
                priority: 40,
            },
            {
                pageNumber: 3,
                priority: 30,
            },
        ]);
        await flushAsync();
        expect(harness.startedRenders).toEqual([1]);

        harness.queue.ensurePage(9, PAGE_PREVIEW_TARGET_PRIORITY);
        await flushAsync();
        expect(harness.startedRenders).toEqual([
            1,
            9,
        ]);

        await harness.resolveRender(9);
        expect(harness.startedRenders).toEqual([
            1,
            9,
        ]);

        harness.queue.ensurePage(10, PAGE_PREVIEW_TARGET_PRIORITY);
        await flushAsync();
        expect(harness.startedRenders).toEqual([
            1,
            9,
            10,
        ]);

        await harness.resolveRender(1);
        expect(harness.startedRenders).toEqual([
            1,
            9,
            10,
            2,
        ]);
    });

    it('prunes queued prefetches without touching in-flight or target requests', async () => {
        const harness = createQueueHarness({ concurrency: 1 });

        harness.queue.ensurePages([
            {
                pageNumber: 1,
                priority: 50,
            },
            {
                pageNumber: 2,
                priority: 40,
            },
            {
                pageNumber: 3,
                priority: 40,
            },
            {
                pageNumber: 4,
                priority: 40,
            },
            {
                pageNumber: 7,
                priority: PAGE_PREVIEW_TARGET_PRIORITY,
            },
        ]);
        await flushAsync();
        expect(harness.startedRenders).toEqual([1]);

        harness.queue.pruneQueuedPrefetches(pageNumber => pageNumber === 3);

        await harness.resolveRender(1);
        expect(harness.startedRenders).toEqual([
            1,
            7,
        ]);

        await harness.resolveRender(7);
        expect(harness.startedRenders).toEqual([
            1,
            7,
            3,
        ]);

        await harness.resolveRender(3);
        expect(harness.startedRenders).toEqual([
            1,
            7,
            3,
        ]);
        expect(harness.cache.has(1, harness.queue.getGeneration())).toBe(true);
    });

    it('tracks a rolling average over the last four successful render durations', async () => {
        let nowMs = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        const harness = createQueueHarness({ concurrency: 1 });

        expect(harness.queue.getAverageRenderDurationMs()).toBeNull();

        const renderDurationsMs = [
            100,
            60,
            40,
            30,
            10,
        ];
        for (const [
            index,
            durationMs,
        ] of renderDurationsMs.entries()) {
            const pageNumber = index + 1;
            harness.queue.ensurePage(pageNumber, 50);
            await flushAsync();
            nowMs += durationMs;
            await harness.resolveRender(pageNumber);
        }

        expect(harness.queue.getAverageRenderDurationMs()).toBe((60 + 40 + 30 + 10) / 4);

        harness.queue.reset();
        expect(harness.queue.getAverageRenderDurationMs()).toBeNull();
    });
});
