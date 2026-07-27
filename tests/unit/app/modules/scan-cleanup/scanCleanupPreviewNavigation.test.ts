// @vitest-environment happy-dom

import {writeFileSync} from 'node:fs';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Ref} from 'vue';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
} from 'vue';
import type {
    IScanCleanupCapability,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewEvent,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import type * as scanCleanupPreviewCacheModule from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import type {IScanCleanupPreviewCache} from '@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache';
import {
    createScanCleanupPagePlanEvidence,
    useScanCleanupPreviewSession,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';

// M2 (U21), page 200 of the reference document, cold: one cleaned preview costs
// 2412 ms. M1: its raw PNG is 1 056 837 B. The raster is modelled as free, the
// same simplification U21's m6-cache-behaviour.ts made, so the rows below stay
// comparable with the baseline it recorded.
const PREVIEW_MS = 2412;
const PAGE_BYTES = 1_056_837;
const TOTAL_PAGES = 392;

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));
const cacheProbe = vi.hoisted(() => ({instances: [] as IScanCleanupPreviewCache[]}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/modules/scan-cleanup/runtime/createScanCleanupPreviewCache', async importOriginal => {
    const actual = await importOriginal<typeof scanCleanupPreviewCacheModule>();
    return {
        ...actual,
        createScanCleanupPreviewCache: (options?: Parameters<typeof actual.createScanCleanupPreviewCache>[0]) => {
            const cache = actual.createScanCleanupPreviewCache(options);
            cacheProbe.instances.push(cache);
            return cache;
        },
    };
});

function scanCleanupOptions(): IScanCleanupOptions {
    return {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'auto',
        binarization: 'auto',
        normalizeIllumination: true,
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckleLevel: 'normal',
        autoDewarp: false,
        skipBlankPages: false,
        pageOverrides: {},
    };
}

const pixelRect = {
    xPx: 0,
    yPx: 0,
    widthPx: 883,
    heightPx: 1335,
};

// A base preview answers without the raster: those bytes crossed once already,
// as the `onPreviewRaw` this backend pushes when the request starts.
function previewResult(pageNumber: number): TScanCleanupPreviewWireResult {
    const bytes = new Uint8Array(new ArrayBuffer(PAGE_BYTES));
    return {
        pageNumber,
        totalPages: TOTAL_PAGES,
        rawWidthPx: 883,
        rawHeightPx: 1335,
        pageMetadata: {
            canvasScope: 'page',
            layoutClassification: 'single-uncut-page',
            layoutConfidence: 0.9,
            cutterXPx: null,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [{
            imageData: bytes,
            metadata: {
                canvasScope: 'page',
                half: 'full',
                warnings: [],
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                sourceRegion: pixelRect,
                contentBox: pixelRect,
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                outputWidthPx: 883,
                outputHeightPx: 1335,
                canvasWidthPx: 883,
                canvasHeightPx: 1335,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
                cutterXPx: null,
                inputWidthPx: 883,
                inputHeightPx: 1335,
                rotationDegrees: 0,
                resamplePasses: 1,
            },
        }],
    };
}

interface IPendingPreview {
    identity: string;
    pageNumber: number;
    promise: Promise<TScanCleanupPreviewWireResult>;
    readyAtMs: number;
    startedAtMs: number;
    resolve: () => void;
    reject: () => void;
}

/**
 * Stands in for createScanCleanupPreviewService over the IPC boundary: base
 * requests are identified by page and content, an identical request joins the
 * one already running instead of spawning again, a spawned request pushes its
 * page raster back before it renders anything, and a cancellation only aborts
 * the pages it was not told to retain.
 */
function previewBackend() {
    let pending: IPendingPreview[] = [];
    const rawListeners = new Set<(raw: IScanCleanupRawPreviewEvent) => void>();
    const counters = {
        spawns: 0,
        joins: 0,
        aborted: 0,
        completed: 0,
    };
    // Every full-page raster this backend puts on the wire, in order. A base
    // result carries none: the raster is the event above.
    const rasterPayloadPages: number[] = [];
    const identityOf = (request: IScanCleanupPreviewRequest) => JSON.stringify([
        request.pageNumber,
        request.options,
        request.documentPrior ?? null,
        request.detail ?? null,
    ]);
    const preview = (request: IScanCleanupPreviewRequest) => {
        const identity = identityOf(request);
        const joined = pending.find(entry => entry.identity === identity);
        if (joined) {
            counters.joins += 1;
            return joined.promise;
        }
        counters.spawns += 1;
        // The service materializes the page raster and pushes it a whole
        // sidecar run before the cleaned outputs it eventually answers with.
        rasterPayloadPages.push(request.pageNumber);
        for (const listener of rawListeners) {
            listener({
                ownerId: request.ownerId,
                documentRevision: request.documentRevision,
                pageNumber: request.pageNumber,
                totalPages: TOTAL_PAGES,
                rawImageData: new Uint8Array(new ArrayBuffer(PAGE_BYTES)),
                rawWidthPx: 883,
                rawHeightPx: 1335,
            });
        }
        const settled = Promise.withResolvers<TScanCleanupPreviewWireResult>();
        const entry: IPendingPreview = {
            identity,
            pageNumber: request.pageNumber,
            readyAtMs: Date.now() + PREVIEW_MS,
            startedAtMs: Date.now(),
            promise: settled.promise,
            resolve: () => {
                counters.completed += 1;
                settled.resolve(previewResult(request.pageNumber));
            },
            // Cancellation answers the request; the service reports it as a
            // result so a page turn is not logged as a handler failure.
            reject: () => {
                counters.aborted += 1;
                settled.resolve({canceled: true});
            },
        };
        pending.push(entry);
        return entry.promise;
    };
    const previewCalls = vi.fn(preview);
    const value: IScanCleanupCapability = {
        preview: previewCalls,
        cancelPreview: vi.fn(async (request: IScanCleanupPreviewCancelRequest) => {
            const retained = new Set(request.retainPages ?? []);
            const doomed = pending.filter(entry => !retained.has(entry.pageNumber));
            pending = pending.filter(entry => retained.has(entry.pageNumber));
            for (const entry of doomed) entry.reject();
            return doomed.length > 0;
        }),
        detectAll: vi.fn(),
        cancelDetection: vi.fn(),
        getDetectionJobState: vi.fn(),
        subscribeDetectionJob: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn(),
        getJobState: vi.fn(),
        subscribeJob: vi.fn(),
        reconnectJob: vi.fn(),
        pruneGeneratedOutputs: vi.fn(),
        onPreviewRaw: vi.fn((listener: (raw: IScanCleanupRawPreviewEvent) => void) => {
            rawListeners.add(listener);
            return () => rawListeners.delete(listener);
        }),
        onJobState: vi.fn(),
        onDetectionJobState: vi.fn(),
    };
    return {
        capability: value,
        counters,
        previewCalls,
        rasterPayloadPages,
        get inFlightPages() {
            return pending.map(entry => entry.pageNumber);
        },
        startedAtMsFor: (pageNumber: number) => pending.find(entry => entry.pageNumber === pageNumber)?.startedAtMs,
        // Retires a run the way the main process does when its generation is
        // superseded or its prefetch lease is dropped: the invoke answers
        // `canceled` without the renderer having asked for anything.
        retire(pageNumber: number) {
            const doomed = pending.filter(entry => entry.pageNumber === pageNumber);
            pending = pending.filter(entry => entry.pageNumber !== pageNumber);
            for (const entry of doomed) entry.reject();
            return doomed.length;
        },
        // Advances the virtual clock, settling every preview whose modelled cost
        // has elapsed and letting the awaiting composable run between each.
        async advanceBy(durationMs: number) {
            const until = Date.now() + durationMs;
            while (Date.now() < until) {
                const next = pending
                    .filter(entry => entry.readyAtMs <= until)
                    .sort((left, right) => left.readyAtMs - right.readyAtMs)[0];
                const target = Math.min(next?.readyAtMs ?? until, Date.now() + 25, until);
                vi.advanceTimersByTime(Math.max(0, target - Date.now()));
                for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
                const due = pending.filter(entry => entry.readyAtMs <= Date.now());
                pending = pending.filter(entry => entry.readyAtMs > Date.now());
                for (const entry of due) {
                    entry.resolve();
                    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
                }
            }
        },
    };
}

function mountPreviewSession(
    previewPage: Ref<number>,
    documentPriorByPage: Map<number, IScanCleanupDocumentPrior>,
    initialViewMode?: 'original' | 'cleaned',
) {
    let session: ReturnType<typeof useScanCleanupPreviewSession> | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup() {
        session = useScanCleanupPreviewSession({
            active: () => true,
            authoritativeLayoutByPage: computed(() => new Map()),
            documentRevision: computed(() => 'revision-1'),
            documentPriorByPage,
            ...(initialViewMode === undefined ? {} : {initialViewMode}),
            lifecycleDocumentKey: computed(() => 'reference.pdf'),
            ownerId: 'owner-1',
            previewPage,
            recommendedOutputModeByPage: new Map(),
            selectPage: page => { previewPage.value = page; },
            settings: reactive(scanCleanupOptions()),
            sourcePath: computed(() => '/docs/reference.pdf'),
            totalPages: computed(() => TOTAL_PAGES),
        });
        return () => h('div');
    }}));
    app.mount(host);
    return {
        session: session!,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

interface IScenario {
    name: string;
    description: string;
    pages: number[];
    intervalMs: number;
    intervalsMs?: number[];
    detectionCompletesAfter?: number;
}

const SCENARIOS: IScenario[] = [
    {
        name: 'read-forward-slow',
        description: 'reading: one page every 4 s, forward',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: 4_000,
    },
    {
        name: 'read-forward-page-turn',
        description: 'page-turning at the speed a preview takes: one page every 2.4 s',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: PREVIEW_MS,
    },
    {
        name: 'flick-forward',
        description: 'flicking the rail: one page every 400 ms, forward',
        pages: Array.from({length: 20}, (_unused, index) => 100 + index),
        intervalMs: 400,
    },
    {
        name: 'flick-then-settle',
        description: 'flick 10 pages at 400 ms, then settle and step around at 4 s',
        pages: [
            ...Array.from({length: 10}, (_unused, index) => 100 + index),
            108,
            107,
            108,
            109,
            110,
        ],
        intervalMs: 400,
        intervalsMs: [
            ...Array.from({length: 9}, () => 400),
            10_000,
            4_000,
            4_000,
            4_000,
            4_000,
            4_000,
        ],
    },
    {
        name: 'compare-two-pages',
        description: 'A/B between two facing pages, 3 s apart',
        pages: [
            200,
            201,
            200,
            201,
            200,
            201,
            200,
            201,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'window-of-five',
        description: 'wandering inside a 5-page window, 3 s apart',
        pages: [
            200,
            202,
            201,
            203,
            204,
            202,
            200,
            203,
            201,
            204,
            202,
            200,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'window-of-ten',
        description: 'wandering inside a 10-page window, 3 s apart — wider than the 8-entry cache',
        pages: [
            200,
            205,
            202,
            208,
            201,
            209,
            203,
            206,
            200,
            207,
            204,
            205,
            202,
            208,
        ],
        intervalMs: 3_000,
    },
    {
        name: 'detection-lands-midway',
        description: 'read 6 pages, detection completes and rewrites documentPrior, revisit the same 6',
        pages: [
            200,
            201,
            202,
            203,
            204,
            205,
            205,
            204,
            203,
            202,
            201,
            200,
        ],
        intervalMs: 4_000,
        detectionCompletesAfter: 6,
    },
];

async function runScenario(scenario: IScenario) {
    cacheProbe.instances.length = 0;
    const backend = previewBackend();
    capability.value = backend.capability;
    const previewPage = ref(scenario.pages[0]!);
    const documentPriorByPage = reactive(new Map<number, IScanCleanupDocumentPrior>());
    const mounted = mountPreviewSession(previewPage, documentPriorByPage);
    const cache = cacheProbe.instances[0]!;
    const counters = {
        navigations: 0,
        visibleHits: 0,
        visibleMisses: 0,
        settledHits: 0,
        settledNavigations: 0,
        orphanedByPriorChange: 0,
    };
    const settledFrom = scenario.intervalsMs?.findIndex(interval => interval >= 4_000) ?? -1;

    for (const [
        index,
        pageNumber,
    ] of scenario.pages.entries()) {
        if (scenario.detectionCompletesAfter === index) {
            counters.orphanedByPriorChange += cache.size;
            for (let page = 1; page <= TOTAL_PAGES; page += 1) {
                documentPriorByPage.set(page, {
                    dominantLayout: 'single-uncut-page',
                    agreementStrength: 0.74,
                } as IScanCleanupDocumentPrior);
            }
            await nextTick();
        }
        previewPage.value = pageNumber;
        await nextTick();
        counters.navigations += 1;
        const hit = !mounted.session.loading.value && mounted.session.result.value?.pageNumber === pageNumber;
        if (hit) counters.visibleHits += 1;
        else counters.visibleMisses += 1;
        if (settledFrom >= 0 && index > settledFrom) {
            counters.settledNavigations += 1;
            if (hit) counters.settledHits += 1;
        }
        await backend.advanceBy(scenario.intervalsMs?.[index] ?? scenario.intervalMs);
    }

    const row = {
        name: scenario.name,
        description: scenario.description,
        navigations: counters.navigations,
        visibleHits: counters.visibleHits,
        visibleMisses: counters.visibleMisses,
        hitRate: Number((counters.visibleHits / counters.navigations).toFixed(3)),
        settledHitRate: counters.settledNavigations === 0
            ? null
            : Number((counters.settledHits / counters.settledNavigations).toFixed(3)),
        previewCalls: backend.previewCalls.mock.calls.length,
        previewSpawns: backend.counters.spawns,
        previewJoins: backend.counters.joins,
        previewCompleted: backend.counters.completed,
        previewAborted: backend.counters.aborted,
        wasteRate: backend.counters.spawns === 0
            ? 0
            : Number((backend.counters.aborted / backend.counters.spawns).toFixed(3)),
        orphanedByPriorChange: counters.orphanedByPriorChange,
        finalCacheEntries: cache.size,
        finalCacheBytes: cache.byteLength,
    };
    mounted.unmount();
    capability.value = null;
    return row;
}

describe('scan cleanup preview navigation', () => {
    it('normalizes valid base-preview geometry for a final run and excludes dewarped output', () => {
        const wire = previewResult(12);
        if (wire.canceled === true) throw new Error('fixture unexpectedly canceled');
        const result = {
            ...wire,
            rawImageData: new Uint8Array([1]),
        };
        expect(createScanCleanupPagePlanEvidence(result)).toEqual({
            pageNumber: 12,
            rotationDegrees: 0,
            layoutClassification: 'single-uncut-page',
            outputs: {full: {contentBox: {
                xNormalized: 0,
                yNormalized: 0,
                widthNormalized: 1,
                heightNormalized: 1,
                rotationDegrees: 0,
            }}},
        });
        expect(createScanCleanupPagePlanEvidence({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    dewarpApplied: true,
                },
            })),
        })).toBeUndefined();
        expect(createScanCleanupPagePlanEvidence({
            ...result,
            pageMetadata: {
                ...result.pageMetadata,
                layoutClassification: 'two-page-spread',
                cutterXPx: result.rawWidthPx * 0.46,
            },
            outputs: [],
        })).toEqual({
            pageNumber: 12,
            rotationDegrees: 0,
            layoutClassification: 'two-page-spread',
            automaticSplit: {
                xNormalized: 0.46,
                rotationDegrees: 0,
            },
            outputs: {},
        });
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
        capability.value = null;
        cacheProbe.instances.length = 0;
    });

    it('keeps navigation from destroying the preview work it just caused', async () => {
        const rows = [];
        for (const scenario of SCENARIOS) rows.push(await runScenario(scenario));
        // Opt-in so the same run that gates the thresholds also produces the
        // comparable table; unset, the suite writes nothing.
        if (process.env.SCAN_CLEANUP_NAVIGATION_REPORT) {
            writeFileSync(process.env.SCAN_CLEANUP_NAVIGATION_REPORT, `${JSON.stringify({
                previewMs: PREVIEW_MS,
                pageBytes: PAGE_BYTES,
                rows,
            }, null, 2)}\n`);
        }
        const byName = new Map(rows.map(row => [
            row.name,
            row,
        ]));

        // Reading forward at 4 s a page used to hit the cache never — the
        // adjacent prefetch only starts once the visible page has rendered, and
        // the next navigation killed it before it could finish.
        expect(byName.get('read-forward-slow')!.hitRate).toBeGreaterThan(0.5);
        expect(byName.get('read-forward-slow')!.previewSpawns).toBeLessThan(30);
        expect(byName.get('read-forward-slow')!.wasteRate).toBeLessThan(0.1);
        // Turning a page every 2.4 s used to render nothing at all: every
        // request was aborted by the following turn.
        expect(byName.get('read-forward-page-turn')!.previewCompleted).toBeGreaterThan(10);
        expect(byName.get('read-forward-page-turn')!.finalCacheEntries).toBeGreaterThan(0);
        // D3 — a 20-navigation flick used to end with an empty cache, and D2 —
        // it used to waste every preview it started, 20 of them.
        expect(byName.get('flick-forward')!.finalCacheEntries).toBeGreaterThan(0);
        expect(byName.get('flick-forward')!.wasteRate).toBeLessThan(0.5);
        expect(byName.get('flick-forward')!.previewSpawns).toBeLessThan(6);
        // D1 — the steps after a flick settles, and the previews the flick threw away.
        expect(byName.get('flick-then-settle')!.settledHitRate).toBeGreaterThan(0.5);
        expect(byName.get('flick-then-settle')!.wasteRate).toBeLessThan(0.5);
        // Detection landing mid-read rewrites every key; the pages read after it
        // used to miss every time.
        expect(byName.get('detection-lands-midway')!.hitRate).toBeGreaterThan(0.3);
    });

    it('adopts the in-flight prefetch of the page the user navigates to instead of restarting it', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        // The adjacent prefetch of 101 is now running.
        await backend.advanceBy(50);
        expect(backend.inFlightPages).toContain(101);
        const prefetchStartedAtMs = backend.startedAtMsFor(101);
        const spawnsBeforeNavigation = backend.counters.spawns;
        const abortedBeforeNavigation = backend.counters.aborted;

        previewPage.value = 101;
        await nextTick();
        await backend.advanceBy(500);

        expect(backend.counters.spawns).toBe(spawnsBeforeNavigation);
        expect(backend.counters.joins).toBeGreaterThan(0);
        expect(backend.counters.aborted).toBe(abortedBeforeNavigation);
        expect(backend.startedAtMsFor(101)).toBe(prefetchStartedAtMs);
        mounted.unmount();
    });

    it.each([
        'cleaned' as const,
        'original' as const,
    ])('spends one request and one raster on a page switch in %s view, raw first', async (viewMode) => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()), viewMode);
        expect(mounted.session.viewMode.value).toBe(viewMode);

        await backend.advanceBy(PREVIEW_MS + 4_000);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        const rastersFor = (pageNumber: number) => backend.rasterPayloadPages
            .filter(page => page === pageNumber).length;
        expect(requestsFor(200)).toBe(0);

        previewPage.value = 200;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        // C1: the switch costs one preview invocation, not a raw leg and then a
        // cleaned one. C2: and the page's raster crosses once for it.
        expect(requestsFor(200)).toBe(1);
        expect(rastersFor(200)).toBe(1);
        // The raw page is on screen while its cleanup runs, in either view
        // mode, and the page being replaced is still the cleaned result.
        expect(mounted.session.rawResult.value?.pageNumber).toBe(200);
        expect(mounted.session.rawResult.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.loading.value).toBe(true);

        await backend.advanceBy(PREVIEW_MS + 100);

        // The cleaned result supersedes it and keeps the raster it was shown
        // with, so the entry cached for this page can still answer Original.
        expect(mounted.session.result.value?.pageNumber).toBe(200);
        expect(mounted.session.result.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(requestsFor(200)).toBe(1);
        expect(rastersFor(200)).toBe(1);

        previewPage.value = 100;
        await nextTick();
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        expect(mounted.session.rawResult.value?.rawImageData.byteLength).toBe(PAGE_BYTES);
        expect(requestsFor(100)).toBe(1);
        expect(rastersFor(100)).toBe(1);
        mounted.unmount();
        capability.value = null;
    });

    it('stops loading when a page is canceled and re-requests it on the next visit', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);

        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(mounted.session.loading.value).toBe(true);
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        expect(requestsFor(400)).toBe(1);

        // The whole document is canceled underneath the page being rendered,
        // which is what a settings change or a closing workspace does.
        mounted.session.cancel();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.error.value).toBe('');
        expect(backend.counters.aborted).toBeGreaterThan(0);

        // Revisiting the page asks for it again rather than waiting on the run
        // that was thrown away.
        previewPage.value = 401;
        await nextTick();
        previewPage.value = 400;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBeGreaterThan(1);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.loading.value).toBe(false);
        mounted.unmount();
        capability.value = null;
    });

    it('re-requests the page it is on when its run answers canceled', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        expect(mounted.session.result.value?.pageNumber).toBe(100);

        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        expect(requestsFor(400)).toBe(1);

        // The run for the page the user is on is retired underneath it. Nothing
        // navigated, so nothing else would ever ask for this page again.
        expect(backend.retire(400)).toBe(1);
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBe(2);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.error.value).toBe('');
        mounted.unmount();
        capability.value = null;
    });

    it('stops re-requesting a page whose run keeps answering canceled', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            backend.retire(400);
            await backend.advanceBy(100);
        }

        // Two retries and then it stops, rather than spinning against a page
        // that cannot be rendered.
        expect(requestsFor(400)).toBe(3);
        // And the page says so: a recoverable error with the Retry the shell
        // already renders, rather than a blank frame and no spinner.
        expect(mounted.session.loading.value).toBe(false);
        expect(mounted.session.resultCurrent.value).toBe(false);
        expect(mounted.session.error.value).not.toBe('');

        // Retrying spends a fresh budget and renders.
        mounted.session.retry();
        await backend.advanceBy(PREVIEW_MS + 500);

        expect(requestsFor(400)).toBe(4);
        expect(mounted.session.error.value).toBe('');
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        mounted.unmount();
        capability.value = null;
    });

    it('gives a page that gave up a fresh budget when the user turns back to it', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        const requestsFor = (pageNumber: number) => backend.previewCalls.mock.calls
            .filter(([request]) => request.pageNumber === pageNumber).length;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            backend.retire(400);
            await backend.advanceBy(100);
        }
        expect(requestsFor(400)).toBe(3);

        previewPage.value = 100;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);
        previewPage.value = 400;
        await nextTick();
        await backend.advanceBy(PREVIEW_MS + 500);

        // The page renders again instead of inheriting the budget the last
        // visit exhausted.
        expect(requestsFor(400)).toBeGreaterThan(3);
        expect(mounted.session.result.value?.pageNumber).toBe(400);
        expect(mounted.session.error.value).toBe('');
        mounted.unmount();
        capability.value = null;
    });

    it('keeps a deliberate page turn immediate when nothing is in flight', async () => {
        const backend = previewBackend();
        capability.value = backend.capability;
        const previewPage = ref(100);
        const mounted = mountPreviewSession(previewPage, reactive(new Map()));

        await backend.advanceBy(PREVIEW_MS + 4_000);
        expect(mounted.session.result.value?.pageNumber).toBe(100);
        const callsBefore = backend.previewCalls.mock.calls.length;

        previewPage.value = 150;
        await nextTick();
        vi.advanceTimersByTime(1);
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        expect(backend.previewCalls.mock.calls.length).toBeGreaterThan(callsBefore);
        mounted.unmount();
    });
});
