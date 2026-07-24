import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import {
    createPdfPageRasterScheduler,
    type IPdfRasterDemand,
    type IPdfRasterDocumentFence,
    type IPdfRasterRenderTarget,
    type TPdfRasterLane,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { resetCoordinatedPdfPageRendersForTest } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { createWorkspaceSurfaceBudgetController } from '@app/utils/document-viewer/workspaceSurfaceBudget';
import { cast } from '@tests/helpers/cast';

const documentFence = {
    documentRevision: null,
    documentVersion: 1,
    loadToken: 1,
} satisfies IPdfRasterDocumentFence;

function createTask(promise: Promise<unknown> = Promise.resolve()) {
    return cast<RenderTask>({
        cancel: vi.fn(),
        promise,
    });
}

function createDemand(
    pageNumber: number,
    lane: TPdfRasterLane,
    generation = 1,
): IPdfRasterDemand {
    return {
        consumerGeneration: generation,
        documentFence,
        estimatedPixels: 100,
        lane,
        ordinal: pageNumber,
        pageNumber,
        renderKey: `${String(generation)}:${String(pageNumber)}`,
        retention: 'render-cache',
    };
}

function createHarness(options: {
    maxConcurrency?: number;
    prepare?: IPdfRasterRenderTarget<{pageNumber: number}>['prepare'];
    surfaceBudgetBytes?: number;
} = {}) {
    const pages = new Map<number, PDFPageProxy>();
    const released: number[] = [];
    const committed: number[] = [];
    const discarded: number[] = [];
    const started: number[] = [];
    const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
        id: 'target',
        prepare: options.prepare ?? (async demand => ({pageNumber: demand.pageNumber})),
        start: prepared => {
            started.push(prepared.pageNumber);
            return createTask();
        },
        commit: (prepared) => {
            committed.push(prepared.pageNumber);
            return true;
        },
        discard: prepared => discarded.push(prepared.pageNumber),
        release: pageNumber => released.push(pageNumber),
    };
    const scheduler = createPdfPageRasterScheduler({
        documentFence,
        leasePage: async (pageNumber) => ({
            page: pages.get(pageNumber) ?? {pageNumber} as PDFPageProxy,
            release: vi.fn(),
        }),
        maxConcurrency: options.maxConcurrency ?? 1,
        surfaceBudget: createWorkspaceSurfaceBudgetController(options.surfaceBudgetBytes ?? 1_000_000),
    });
    return {
        committed,
        discarded,
        released,
        scheduler,
        started,
        target,
    };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('PdfPageRasterScheduler', () => {
    afterEach(() => {
        vi.useRealTimers();
        resetCoordinatedPdfPageRendersForTest();
    });

    it('orders navigation and viewport demand ahead of thumbnails and prefetch', async () => {
        const harness = createHarness();
        const demands = [
            createDemand(1, 'prefetch'),
            createDemand(2, 'thumbnail-current'),
            createDemand(3, 'viewport-visible'),
            createDemand(4, 'navigation-target'),
        ];
        harness.scheduler.setDemand({
            sourceId: 'all',
            input: demands,
            policy: {
                expand: input => input,
                compareWithinLane: (left, right) => left.ordinal - right.ordinal,
            },
            target: harness.target,
        });

        await flush();
        await vi.waitFor(() => expect(harness.committed).toHaveLength(4));

        expect(harness.started).toEqual([
            4,
            3,
            2,
            1,
        ]);
    });

    it('deduplicates the same target, page, and render key', async () => {
        const harness = createHarness();
        const demand = createDemand(3, 'viewport-visible');
        const policy = {
            expand: () => [demand],
            compareWithinLane: () => 0,
        };

        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: null,
            policy,
            target: harness.target,
        });
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: null,
            policy,
            target: harness.target,
        });
        await vi.waitFor(() => expect(harness.committed).toEqual([3]));
    });

    it('rejects one-shot requests outside navigation-target', async () => {
        const harness = createHarness();

        await expect(harness.scheduler.request({
            sourceId: 'viewport',
            demand: createDemand(1, 'viewport-visible'),
            target: harness.target,
        })).rejects.toThrow('navigation-target');
    });

    it('preempts lower-priority same-page work and waits for its PDF.js task to settle', async () => {
        const page = {pageNumber: 7} as PDFPageProxy;
        const lowTask = Promise.withResolvers<undefined>();
        const highTask = Promise.withResolvers<undefined>();
        const cancelLow = vi.fn();
        const starts: string[] = [];
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async () => ({
                page,
                release: vi.fn(),
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const lowTarget: IPdfRasterRenderTarget<{kind: string}> = {
            id: 'low',
            prepare: async () => ({kind: 'low'}),
            start: () => {
                starts.push('low');
                return cast<RenderTask>({
                    cancel: cancelLow,
                    promise: lowTask.promise,
                });
            },
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const highTarget: IPdfRasterRenderTarget<{kind: string}> = {
            id: 'high',
            prepare: async () => ({kind: 'high'}),
            start: () => {
                starts.push('high');
                return createTask(highTask.promise);
            },
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const lowDemand = createDemand(7, 'thumbnail-current');
        scheduler.setDemand({
            sourceId: 'thumbnails',
            input: [lowDemand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: lowTarget,
        });
        await vi.waitFor(() => expect(starts).toEqual(['low']));

        const highRun = scheduler.request({
            sourceId: 'navigation',
            demand: {
                ...createDemand(7, 'navigation-target'),
                renderKey: 'navigation:7',
            },
            target: highTarget,
        });
        await vi.waitFor(() => expect(cancelLow).toHaveBeenCalledOnce());
        expect(starts).toEqual(['low']);

        lowTask.resolve(undefined);
        await vi.waitFor(() => expect(starts).toEqual([
            'low',
            'high',
        ]));
        highTask.resolve(undefined);
        await expect(highRun).resolves.toMatchObject({status: 'committed'});
    });

    it('releases a page lease exactly once and only after render settlement', async () => {
        const render = Promise.withResolvers<undefined>();
        const release = vi.fn();
        const started = vi.fn();
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release,
            }),
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        const outcome = scheduler.request({
            sourceId: 'navigation',
            demand: createDemand(1, 'navigation-target'),
            target: {
                id: 'lease-order',
                prepare: async () => ({}),
                start: () => {
                    started();
                    return createTask(render.promise);
                },
                commit: () => true,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
        expect(release).not.toHaveBeenCalled();

        render.resolve(undefined);
        await outcome;
        expect(release).toHaveBeenCalledOnce();
    });

    it('cancels active source work and waits for its task before releasing the lease', async () => {
        const render = Promise.withResolvers<undefined>();
        const release = vi.fn();
        const cancel = vi.fn(() => {
            const error = new Error('cancelled');
            error.name = 'RenderingCancelledException';
            render.reject(error);
        });
        const commit = vi.fn(() => true);
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release,
            }),
            surfaceBudget: createWorkspaceSurfaceBudgetController(1_000),
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'cancel',
                prepare: async () => ({}),
                start: () => cast<RenderTask>({
                    cancel,
                    promise: render.promise,
                }),
                commit,
                discard: vi.fn(),
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(scheduler.snapshot().inFlightPages).toHaveLength(1));

        await scheduler.cancelSource('viewport');

        expect(cancel).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it('discards a stale consumer generation without committing it', async () => {
        const prepareGate = Promise.withResolvers<{pageNumber: number} | null>();
        const harness = createHarness({prepare: () => prepareGate.promise});
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible', 1)],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        await flush();
        harness.scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible', 2)],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        prepareGate.resolve({pageNumber: 1});
        await flush();

        expect(harness.committed).toEqual([]);
        expect(harness.discarded).toEqual([1]);
    });

    it('releases a reservation when prepare fails and retries the demand', async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const harness = createHarness({prepare: async demand => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('prepare failed');
            }
            return {pageNumber: demand.pageNumber};
        }});
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: harness.target,
        });
        await flush();
        expect(budget.getSnapshot().reservedBytes).toBe(0);

        await vi.advanceTimersByTimeAsync(16);
        await flush();

        expect(attempts).toBe(2);
        expect(budget.getSnapshot().reservedBytes).toBe(400);
    });

    it('discards a rejected commit and releases its surface reservation', async () => {
        const budget = createWorkspaceSurfaceBudgetController(1_000);
        const release = vi.fn();
        const discard = vi.fn();
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release,
            }),
            surfaceBudget: budget,
        });
        scheduler.setDemand({
            sourceId: 'viewport',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                id: 'commit-reject',
                prepare: async () => ({pageNumber: 1}),
                start: () => createTask(),
                commit: () => false,
                discard,
                release: vi.fn(),
            },
        });
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

        expect(discard).toHaveBeenCalledOnce();
        expect(budget.getSnapshot().reservedBytes).toBe(0);
    });

    it('evicts prefetch residency before required viewport residency', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'budget-order',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        const setOne = (sourceId: string, demand: IPdfRasterDemand) => {
            scheduler.setDemand({
                sourceId,
                input: [demand],
                policy: {
                    expand: input => input,
                    compareWithinLane: () => 0,
                },
                target,
            });
        };
        setOne('required-1', createDemand(1, 'viewport-visible'));
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toHaveLength(1));
        setOne('prefetch-2', createDemand(2, 'prefetch'));
        await vi.waitFor(() => expect(scheduler.snapshot().residentPages).toHaveLength(2));
        setOne('required-3', createDemand(3, 'viewport-visible'));
        await vi.waitFor(() => expect(
            scheduler.snapshot().residentPages.map(entry => entry.pageNumber).sort(),
        ).toEqual([
            1,
            3,
        ]));

        expect(budget.getSnapshot().reservedBytes).toBe(800);
    });

    it('cancels viewport and thumbnail work on rapid source replacement', async () => {
        const renders = new Map<number, ReturnType<typeof Promise.withResolvers<undefined>>>();
        const cancelled: number[] = [];
        const committed: number[] = [];
        const scheduler = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release: vi.fn(),
            }),
            maxConcurrency: 2,
            surfaceBudget: createWorkspaceSurfaceBudgetController(2_000),
        });
        const target: IPdfRasterRenderTarget<{pageNumber: number}> = {
            id: 'replacement',
            prepare: async demand => ({pageNumber: demand.pageNumber}),
            start: ({pageNumber}) => {
                if (pageNumber > 2) {
                    return createTask();
                }
                const render = Promise.withResolvers<undefined>();
                renders.set(pageNumber, render);
                return cast<RenderTask>({
                    cancel: () => {
                        cancelled.push(pageNumber);
                        const error = new Error('replaced');
                        error.name = 'RenderingCancelledException';
                        render.reject(error);
                    },
                    promise: render.promise,
                });
            },
            commit: ({pageNumber}) => {
                committed.push(pageNumber);
                return true;
            },
            discard: vi.fn(),
            release: vi.fn(),
        };
        const setSource = (
            sourceId: string,
            demand: IPdfRasterDemand,
        ) => scheduler.setDemand({
            sourceId,
            input: [demand],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target,
        });
        setSource('viewport', createDemand(1, 'viewport-visible'));
        setSource('thumbnails', createDemand(2, 'thumbnail-visible'));
        await vi.waitFor(() => expect(renders.size).toBe(2));

        setSource('viewport', createDemand(3, 'viewport-visible', 2));
        setSource('thumbnails', createDemand(4, 'thumbnail-current', 2));
        await vi.waitFor(() => expect(committed.sort()).toEqual([
            3,
            4,
        ]));

        expect(cancelled.sort()).toEqual([
            1,
            2,
        ]);
    });

    it('isolates a new document from a predecessor wedged in prepare and reclaims its budget', async () => {
        const budget = createWorkspaceSurfaceBudgetController(800);
        const wedgedPrepare = new Promise<never>(() => {});
        const releaseA = vi.fn();
        const schedulerA = createPdfPageRasterScheduler({
            documentFence,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release: releaseA,
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const targetA: IPdfRasterRenderTarget<never> = {
            id: 'a',
            prepare: () => wedgedPrepare,
            start: () => createTask(),
            commit: () => true,
            discard: vi.fn(),
            release: vi.fn(),
        };
        schedulerA.setDemand({
            sourceId: 'viewport-a',
            input: [createDemand(1, 'viewport-visible')],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: targetA,
        });
        await flush();
        expect(budget.getSnapshot().reservedBytes).toBe(400);

        schedulerA.invalidate({
            documentFence,
            reason: 'document-a-invalidated',
        });
        expect(budget.getSnapshot().reservedBytes).toBe(0);
        expect(releaseA).toHaveBeenCalledOnce();

        const fenceB = {
            ...documentFence,
            documentVersion: 2,
            loadToken: 2,
        };
        const committedB = vi.fn(() => true);
        const schedulerB = createPdfPageRasterScheduler({
            documentFence: fenceB,
            leasePage: async pageNumber => ({
                page: {pageNumber} as PDFPageProxy,
                release: vi.fn(),
            }),
            maxConcurrency: 1,
            surfaceBudget: budget,
        });
        const demandB = {
            ...createDemand(2, 'viewport-visible'),
            documentFence: fenceB,
        };
        schedulerB.setDemand({
            sourceId: 'viewport-b',
            input: [demandB],
            policy: {
                expand: input => input,
                compareWithinLane: () => 0,
            },
            target: {
                ...targetA,
                id: 'b',
                prepare: async () => ({pageNumber: 2}),
                commit: committedB,
            },
        });
        await vi.waitFor(() => expect(committedB).toHaveBeenCalledOnce());

        expect(budget.getSnapshot().reservedBytes).toBe(400);
        expect(schedulerB.snapshot()).toMatchObject({
            queueDepth: 0,
            inFlightPages: [],
            residentPages: [{
                pageNumber: 2,
                sourceId: 'viewport-b',
            }],
        });
    });
});
