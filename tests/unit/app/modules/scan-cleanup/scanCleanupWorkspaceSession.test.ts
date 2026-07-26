// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import type {
    IScanCleanupCapability,
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import {createScanCleanupPreviewCacheKey} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {
    scanCleanupAutoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {
    getScanCleanupPreferencesStore,
    resetScanCleanupPreferencesStore,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';
import {scanCleanupRun} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (
    key: string,
    values?: Record<string, unknown>,
) => values?.output === undefined ? key : `${key}:${String(values.output)}`})}));

function previewResult(
    pageNumber: number,
    classification: IScanCleanupPreviewResult['pageMetadata']['layoutClassification'],
): IScanCleanupPreviewResult {
    return {
        pageNumber,
        totalPages: 3,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1,
        rawHeightPx: 1,
        pageMetadata: {
            canvasScope: 'page',
            layoutClassification: classification,
            layoutConfidence: 0.9,
            cutterXPx: null,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: classification,
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [],
    };
}

function scanCleanupOptions(): IScanCleanupOptions {
    return {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'bw',
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
        despeckle: true,
        skipBlankPages: false,
        pageOverrides: {},
    };
}

function detectionState(
    jobId: string,
    status: 'queued' | 'completed' | 'canceled',
    totalPages = 3,
): TScanCleanupDetectionJobState {
    const results = status === 'queued'
        ? []
        : Array.from({length: totalPages}, (_, index) => ({
            pageNumber: index + 1,
            classification: 'single-uncut-page' as const,
            confidence: 0.9,
            cutterXPx: null,
            tier1Verdict: 'single-uncut-page' as const,
            reconciled: false,
            clusterAgreement: 0,
            documentPrior: null,
        }));
    return {
        jobId,
        status,
        progress: {
            stage: 'detecting',
            completedUnits: results.length,
            totalUnits: totalPages,
            percent: results.length / totalPages * 100,
            completedPageNumbers: results.map(result => result.pageNumber),
        },
        results,
        updatedAtMs: Date.now(),
    };
}

function capabilityHarness() {
    let nextJob = 0;
    let detectionListener: (state: TScanCleanupDetectionJobState) => void = () => undefined;
    let runListener: (state: TScanCleanupJobState) => void = () => undefined;
    const value: IScanCleanupCapability = {
        preview: vi.fn(async () => {
            throw new DOMException('Superseded', 'AbortError');
        }),
        cancelPreview: vi.fn(async () => true),
        detectAll: vi.fn(async () => ({
            started: true as const,
            jobId: `detect-${++nextJob}`,
        })),
        cancelDetection: vi.fn(async () => true),
        getDetectionJobState: vi.fn(async () => null),
        subscribeDetectionJob: vi.fn(async jobId => detectionState(jobId, 'queued')),
        start: vi.fn(),
        cancel: vi.fn(),
        getJobState: vi.fn(),
        subscribeJob: vi.fn(),
        reconnectJob: vi.fn(),
        pruneGeneratedOutputs: vi.fn(),
        onPreviewRaw: vi.fn(() => () => undefined),
        onJobState: vi.fn(listener => {
            runListener = listener;
            return () => { runListener = () => undefined; };
        }),
        onDetectionJobState: vi.fn(listener => {
            detectionListener = listener;
            return () => { detectionListener = () => undefined; };
        }),
    };
    return {
        emitDetection: (state: TScanCleanupDetectionJobState) => detectionListener(state),
        emitRun: (state: TScanCleanupJobState) => runListener(state),
        value,
    };
}

function mountSession(documentKey: string, overrides: {
    active?: () => boolean;
    currentPage?: () => number;
    documentRevision?: () => string | null;
    initialPreviewPage?: () => number | undefined;
    sourcePath?: () => string | null;
    totalPages?: () => number;
} = {}) {
    let session: ReturnType<typeof useScanCleanupWorkspaceSession> | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup() {
        session = useScanCleanupWorkspaceSession({
            active: overrides.active ?? (() => true),
            sourcePath: overrides.sourcePath ?? (() => `/docs/${documentKey}.pdf`),
            documentKey: () => documentKey,
            ...(overrides.documentRevision === undefined
                ? {}
                : {documentRevision: overrides.documentRevision}),
            currentPage: overrides.currentPage ?? (() => 1),
            totalPages: overrides.totalPages ?? (() => 3),
            ...(overrides.initialPreviewPage === undefined
                ? {}
                : {initialPreviewPage: overrides.initialPreviewPage}),
        });
        return () => h('div');
    }}));
    app.mount(host);
    return {
        get session() {
            return session!;
        },
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

describe('scan cleanup workspace session detection guidance', () => {
    beforeEach(() => {
        resetScanCleanupPreferencesStore();
        localStorage.clear();
        scanCleanupAutoDetectionCanceledDocuments.clear();
        scanCleanupDetectionSessionCache.clear();
        scanCleanupRun.activeJobId = null;
        scanCleanupRun.inFlight = false;
        scanCleanupRun.workspaceOwnerIds.clear();
        scanCleanupRun.jobState = null;
        scanCleanupRun.lastError = null;
        scanCleanupRun.ownerDocumentRef = null;
        scanCleanupRun.ownerDocumentRevision = null;
        scanCleanupRun.ownerId = null;
    });

    afterEach(() => {
        capability.value = null;
    });

    it('accumulates settled pages across the reading and detecting stages of one job', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession('settled-pages');
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const settled = mounted.session.detection.settledPages;

        // Reading the source reports pages one by one and carries no results at
        // all; without this signal every thumbnail spun for the whole stage.
        harness.emitDetection({
            ...detectionState('detect-1', 'queued'),
            status: 'running',
            progress: {
                stage: 'rasterizing',
                completedUnits: 2,
                totalUnits: 3,
                percent: 66,
                completedPageNumbers: [
                    1,
                    3,
                ],
            },
            updatedAtMs: Date.now() + 1_000,
        });
        await vi.waitFor(() => expect(settled.has(1)).toBe(true));
        expect([...settled].sort((left, right) => left - right)).toEqual([
            1,
            3,
        ]);

        // The analysis stage reports a different set; neither replaces the other.
        harness.emitDetection({
            ...detectionState('detect-1', 'queued'),
            status: 'running',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 33,
                completedPageNumbers: [2],
            },
            updatedAtMs: Date.now() + 2_000,
        });
        await vi.waitFor(() => expect(settled.has(2)).toBe(true));
        expect([...settled].sort((left, right) => left - right)).toEqual([
            1,
            2,
            3,
        ]);

        mounted.unmount();
    });

    it('settles every page a coalesced snapshot reports, not one page per event', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession('coalesced-settled-pages');
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const settled = mounted.session.detection.settledPages;

        // The progress pump coalesces: a snapshot supersedes the pending ones it
        // replaces, so the events that reported pages 2 and 3 on their own are
        // never delivered. Each snapshot carries the whole completed set, and a
        // consumer that counted events would leave those pages spinning.
        harness.emitDetection({
            ...detectionState('detect-1', 'queued', 4),
            status: 'running',
            progress: {
                stage: 'rasterizing',
                completedUnits: 1,
                totalUnits: 4,
                percent: 25,
                completedPageNumbers: [1],
            },
            updatedAtMs: Date.now() + 1_000,
        });
        await vi.waitFor(() => expect(settled.has(1)).toBe(true));

        harness.emitDetection({
            ...detectionState('detect-1', 'queued', 4),
            status: 'running',
            progress: {
                stage: 'rasterizing',
                completedUnits: 4,
                totalUnits: 4,
                percent: 100,
                completedPageNumbers: [
                    1,
                    2,
                    3,
                    4,
                ],
            },
            updatedAtMs: Date.now() + 2_000,
        });
        await vi.waitFor(() => expect(settled.size).toBe(4));
        expect([...settled].sort((left, right) => left - right)).toEqual([
            1,
            2,
            3,
            4,
        ]);

        // Analysis streams only the classifications this subscriber has not seen
        // yet, so a snapshot's results are a delta while its progress stays
        // whole: the earlier page keeps its classification and stays settled.
        harness.emitDetection({
            jobId: 'detect-1',
            status: 'running',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 4,
                percent: 25,
                completedPageNumbers: [1],
            },
            results: [{
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.9,
                cutterXPx: null,
                tier1Verdict: 'two-page-spread',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
            }],
            updatedAtMs: Date.now() + 3_000,
        });
        await vi.waitFor(() => expect(
            mounted.session.detection.authoritativeLayoutByPage.value.get(1),
        ).toBe('two-page-spread'));

        harness.emitDetection({
            jobId: 'detect-1',
            status: 'running',
            progress: {
                stage: 'detecting',
                completedUnits: 2,
                totalUnits: 4,
                percent: 50,
                completedPageNumbers: [
                    1,
                    2,
                ],
            },
            results: [{
                pageNumber: 2,
                classification: 'page-with-offcut',
                confidence: 0.9,
                cutterXPx: null,
                tier1Verdict: 'page-with-offcut',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
            }],
            updatedAtMs: Date.now() + 4_000,
        });
        await vi.waitFor(() => expect(
            mounted.session.detection.authoritativeLayoutByPage.value.get(2),
        ).toBe('page-with-offcut'));
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1)).toBe('two-page-spread');
        expect(settled.size).toBe(4);

        mounted.unmount();
    });

    it('starts a fresh session on the reader current page when no cleanup page is restored', () => {
        capability.value = capabilityHarness().value;
        const mounted = mountSession(`fresh-preview-page-${Date.now()}`, {
            currentPage: () => 37,
            initialPreviewPage: () => undefined,
            totalPages: () => 100,
        });

        expect(mounted.session.selection.leader.value).toBe(37);
        mounted.unmount();
    });

    it('auto-switches only for intentional multi-selection and its collapse', () => {
        capability.value = capabilityHarness().value;
        const mounted = mountSession(`scope-selection-${Date.now()}`);

        expect(mounted.session.selection.settingsScope.value).toBe('all');
        expect(mounted.session.run.runLabel.value).toBe('scanCleanup.cleanUp');
        mounted.session.selection.selectPage(2, 'single', [
            1,
            2,
            3,
        ]);
        expect(mounted.session.selection.settingsScope.value).toBe('all');

        mounted.session.selection.selectPage(3, 'toggle', [
            1,
            2,
            3,
        ]);
        expect(mounted.session.selection.selectedPages.value).toEqual(new Set([
            2,
            3,
        ]));
        expect(mounted.session.selection.settingsScope.value).toBe('selected');
        expect(mounted.session.selection.highlightedScope.value).toBe('selected');
        expect(mounted.session.run.runLabel.value).toBe('scanCleanup.cleanUpPages');

        mounted.session.selection.selectPage(2, 'single', [
            1,
            2,
            3,
        ]);
        expect(mounted.session.selection.selectedPages.value).toEqual(new Set([2]));
        expect(mounted.session.selection.settingsScope.value).toBe('page');
        expect(mounted.session.selection.highlightedScope.value).toBe('page');
        expect(mounted.session.run.runLabel.value).toBe('scanCleanup.cleanUpPage');

        mounted.session.selection.setSettingsScope('all');
        mounted.session.selection.selectPage(1, 'single', [
            1,
            2,
            3,
        ]);
        expect(mounted.session.selection.settingsScope.value).toBe('all');
        mounted.unmount();
    });

    it('holds the initial loading state through debounce, then settles preview success and failure', async () => {
        const successHarness = capabilityHarness();
        const pendingPreview = Promise.withResolvers<IScanCleanupPreviewResult>();
        vi.mocked(successHarness.value.preview).mockImplementation(async request => request.pageNumber === 1
            ? pendingPreview.promise
            : previewResult(request.pageNumber, 'single-uncut-page'));
        capability.value = successHarness.value;
        const successful = mountSession(`preview-sequence-success-${Date.now()}`);

        expect(successful.session.preview.loading.value).toBe(true);
        expect(successful.session.preview.result.value).toBeNull();
        expect(successful.session.preview.error.value).toBe('');
        await vi.waitFor(() => expect(successHarness.value.preview).toHaveBeenCalled());
        expect(successful.session.preview.loading.value).toBe(true);

        pendingPreview.resolve(previewResult(1, 'single-uncut-page'));
        await vi.waitFor(() => expect(successful.session.preview.result.value?.pageNumber).toBe(1));
        expect(successful.session.preview.loading.value).toBe(false);
        expect(successful.session.preview.error.value).toBe('');
        successful.unmount();

        const failureHarness = capabilityHarness();
        vi.mocked(failureHarness.value.preview).mockRejectedValue(new Error('preview boundary failed'));
        capability.value = failureHarness.value;
        const failed = mountSession(`preview-sequence-failure-${Date.now()}`);

        expect(failed.session.preview.loading.value).toBe(true);
        await vi.waitFor(() => expect(failed.session.preview.error.value).toBe('preview boundary failed'));
        expect(failed.session.preview.loading.value).toBe(false);
        expect(failed.session.preview.result.value).toBeNull();
        failed.unmount();
    });

    it('lets a cached detail viewport supersede an older in-flight detail render', async () => {
        const harness = capabilityHarness();
        const olderDetail = Promise.withResolvers<IScanCleanupPreviewResult>();
        const cachedDetail = previewResult(1, 'single-uncut-page');
        const staleDetail = previewResult(1, 'two-page-spread');
        vi.mocked(harness.value.preview).mockImplementation(async request => {
            if (!request.detail) {
                return previewResult(request.pageNumber, 'single-uncut-page');
            }
            return request.detail.viewports.full?.xNormalized === 0
                ? cachedDetail
                : olderDetail.promise;
        });
        capability.value = harness.value;
        const mounted = mountSession(`detail-cache-order-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));
        const cachedViewport = {full: {
            xNormalized: 0,
            yNormalized: 0,
            widthNormalized: 0.5,
            heightNormalized: 1,
            rotationDegrees: 0 as const,
        }};
        const olderViewport = {full: {
            xNormalized: 0.5,
            yNormalized: 0,
            widthNormalized: 0.5,
            heightNormalized: 1,
            rotationDegrees: 0 as const,
        }};

        await mounted.session.preview.requestDetail(cachedViewport);
        expect(mounted.session.preview.detailResult.value).toBe(cachedDetail);
        const olderRequest = mounted.session.preview.requestDetail(olderViewport);
        await vi.waitFor(() => expect(
            vi.mocked(harness.value.preview).mock.calls.filter(([request]) => request?.detail).length,
        ).toBe(2));

        await mounted.session.preview.requestDetail(cachedViewport);
        expect(mounted.session.preview.detailResult.value?.pageMetadata.layoutClassification)
            .toBe('single-uncut-page');
        olderDetail.resolve(staleDetail);
        await olderRequest;

        expect(mounted.session.preview.detailResult.value?.pageMetadata.layoutClassification)
            .toBe('single-uncut-page');
        mounted.unmount();
    });

    it('clears a displayed detail tile immediately when its viewport becomes stale', async () => {
        const harness = capabilityHarness();
        const detail = previewResult(1, 'single-uncut-page');
        vi.mocked(harness.value.preview).mockImplementation(async request => (
            request.detail
                ? detail
                : previewResult(request.pageNumber, 'single-uncut-page')
        ));
        capability.value = harness.value;
        const mounted = mountSession(`detail-clear-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));

        await mounted.session.preview.requestDetail({full: {
            xNormalized: 0,
            yNormalized: 0,
            widthNormalized: 0.5,
            heightNormalized: 0.5,
            rotationDegrees: 0,
        }});
        expect(mounted.session.preview.detailResult.value).toBe(detail);

        mounted.session.preview.clearDetail();

        expect(mounted.session.preview.detailResult.value).toBeNull();
        expect(mounted.session.preview.detailLoading.value).toBe(false);
        mounted.unmount();
    });

    it('cancels a pending detail retry when the preview source disappears', async () => {
        const harness = capabilityHarness();
        const sourcePath = ref<string | null>(`/docs/detail-retry-source-${Date.now()}.pdf`);
        vi.mocked(harness.value.preview).mockImplementation(async request => {
            if (request.detail) {
                throw new Error('temporary detail failure');
            }
            return previewResult(request.pageNumber, 'single-uncut-page');
        });
        capability.value = harness.value;
        const mounted = mountSession(
            `detail-retry-identity-${Date.now()}`,
            {sourcePath: () => sourcePath.value},
        );
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));
        vi.useFakeTimers();
        try {
            await mounted.session.preview.requestDetail({full: {
                xNormalized: 0,
                yNormalized: 0,
                widthNormalized: 1,
                heightNormalized: 1,
                rotationDegrees: 0,
            }});
            expect(vi.mocked(harness.value.preview).mock.calls.filter(([request]) => request?.detail))
                .toHaveLength(1);

            sourcePath.value = null;
            await nextTick();
            await vi.advanceTimersByTimeAsync(1_000);

            expect(vi.mocked(harness.value.preview).mock.calls.filter(([request]) => request?.detail))
                .toHaveLength(1);
            expect(mounted.session.preview.detailLoading.value).toBe(false);
        } finally {
            vi.useRealTimers();
            mounted.unmount();
        }
    });

    it('accumulates the classifications a detection streams one progress event at a time', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`incremental-detection-${Date.now()}`);

        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const classifications = [
            'two-page-spread',
            'page-with-offcut',
            'single-uncut-page',
        ] as const;
        classifications.forEach((classification, index) => {
            const pageNumber = index + 1;
            harness.emitDetection({
                jobId: 'detect-1',
                status: 'running',
                progress: {
                    stage: 'detecting',
                    completedUnits: pageNumber,
                    totalUnits: 3,
                    percent: pageNumber / 3 * 100,
                    completedPageNumbers: Array.from({length: pageNumber}, (_, page) => page + 1),
                },
                results: [{
                    pageNumber,
                    classification,
                    confidence: 0.9,
                    cutterXPx: null,
                    tier1Verdict: classification,
                    reconciled: false,
                    clusterAgreement: 0,
                    documentPrior: null,
                }],
                updatedAtMs: Date.now() + pageNumber,
            });
        });
        await nextTick();

        expect([...mounted.session.detection.authoritativeLayoutByPage.value]).toEqual([
            [
                1,
                'two-page-spread',
            ],
            [
                2,
                'page-with-offcut',
            ],
            [
                3,
                'single-uncut-page',
            ],
        ]);
        mounted.unmount();
    });

    it('auto-detects on open and does not auto-restart a document after user cancellation', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `cancel-${Date.now()}`;
        const first = mountSession(documentKey);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        expect(Object.keys(first.session)).toEqual([
            'selection',
            'settings',
            'detection',
            'preview',
            'run',
        ]);
        expect(first.session.detection.pending.value).toBe(true);
        await first.session.detection.cancel();
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        first.unmount();

        const reopened = mountSession(documentKey);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        expect(reopened.session.detection.pending.value).toBe(false);
        reopened.unmount();
    });

    it('shares global preferences while keeping output mode scoped to its document', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const firstKey = `preferences-a-${Date.now()}`;
        const secondKey = `preferences-b-${Date.now()}`;
        const first = mountSession(firstKey);
        const second = mountSession(secondKey);

        first.session.settings.values.outputMode = 'color';
        expect(second.session.settings.values.outputMode).toBe('auto');
        second.session.settings.values.readingOrder = 'rtl';
        expect(first.session.settings.values.readingOrder).toBe('rtl');

        await vi.waitFor(() => expect(JSON.parse(
            localStorage.getItem('evb.scanCleanup.settings.v1') ?? '{}',
        )).toMatchObject({readingOrder: 'rtl'}));
        expect(JSON.parse(localStorage.getItem('evb.scanCleanup.settings.v1') ?? '{}'))
            .not.toHaveProperty('outputMode');
        await vi.waitFor(() => expect(JSON.parse(
            localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}',
        )[firstKey]).toMatchObject({outputMode: 'color'}));
        first.unmount();
        second.unmount();

        const reopened = mountSession(firstKey);
        expect(reopened.session.settings.values.outputMode).toBe('color');
        reopened.unmount();
    });

    it('does not restore a detection result that resolves after the surface is disposed', async () => {
        const harness = capabilityHarness();
        const subscription = Promise.withResolvers<TScanCleanupDetectionJobState | null>();
        vi.mocked(harness.value.subscribeDetectionJob).mockImplementation(() => subscription.promise);
        capability.value = harness.value;
        const mounted = mountSession(`late-subscribe-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.subscribeDetectionJob).toHaveBeenCalledOnce());
        mounted.unmount();
        subscription.resolve(detectionState('detect-1', 'completed'));
        await subscription.promise;
        await Promise.resolve();

        expect(scanCleanupDetectionSessionCache.size).toBe(0);
    });

    it('rejects an older subscribe response after a newer detection event without regressing progress or maps', async () => {
        const harness = capabilityHarness();
        const subscription = Promise.withResolvers<TScanCleanupDetectionJobState | null>();
        vi.mocked(harness.value.subscribeDetectionJob).mockImplementation(() => subscription.promise);
        capability.value = harness.value;
        const mounted = mountSession(`monotonic-detection-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.subscribeDetectionJob).toHaveBeenCalledOnce());
        const newerUpdatedAt = Date.now() + 1_000;
        const newer = detectionState('detect-1', 'completed');
        newer.status = 'running';
        newer.results = newer.results.slice(0, 2);
        newer.results[0] = {
            ...newer.results[0]!,
            classification: 'two-page-spread',
            recommendedOutputMode: 'color',
            recommendedOutputModeConfidence: 0.93,
        };
        newer.progress = {
            stage: 'detecting',
            completedUnits: 2,
            totalUnits: 3,
            percent: 200 / 3,
            completedPageNumbers: [
                1,
                2,
            ],
        };
        newer.updatedAtMs = newerUpdatedAt;
        harness.emitDetection(newer);
        await vi.waitFor(() => expect(mounted.session.detection.progress.value.completedUnits).toBe(2));
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1)).toBe('two-page-spread');
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');

        subscription.resolve({
            ...detectionState('detect-1', 'queued'),
            updatedAtMs: newerUpdatedAt - 1,
        });
        await subscription.promise;
        await nextTick();

        expect(mounted.session.detection.progress.value.completedUnits).toBe(2);
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1)).toBe('two-page-spread');
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');
        mounted.unmount();
    });

    it('cancels active detection, waits for its terminal state, and starts cleanup exactly once', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`detection-to-run-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const canceling = {
            ...detectionState('detect-1', 'queued'),
            status: 'canceling' as const,
            updatedAtMs: Date.now() + 1,
        };
        vi.mocked(harness.value.getDetectionJobState).mockResolvedValue(canceling);
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-detection',
            outputPdfPath: '/managed/cleanup-after-detection.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-detection',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 3,
        });

        expect(mounted.session.run.canRun.value).toBe(true);
        const firstRun = mounted.session.run.run();
        const secondRun = mounted.session.run.run();
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledOnce());
        expect(harness.value.start).not.toHaveBeenCalled();
        expect(mounted.session.run.transitionText.value).toBe('scanCleanup.cancelingDetection');

        harness.emitDetection({
            ...detectionState('detect-1', 'canceled'),
            results: [],
            progress: canceling.progress,
            updatedAtMs: canceling.updatedAtMs + 1,
        });
        await Promise.all([
            firstRun,
            secondRun,
        ]);

        expect(harness.value.cancelDetection).toHaveBeenCalledOnce();
        expect(harness.value.start).toHaveBeenCalledOnce();
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
        mounted.unmount();
    });

    it('settles cancellation after the lifecycle clears the job id and aborts a revision-changed run', async () => {
        const harness = capabilityHarness();
        const revision = ref('revision-1');
        capability.value = harness.value;
        const mounted = mountSession(
            `revision-during-cancel-${Date.now()}`,
            {documentRevision: () => revision.value},
        );
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const canceling = {
            ...detectionState('detect-1', 'queued'),
            status: 'canceling' as const,
            updatedAtMs: Date.now() + 1,
        };
        vi.mocked(harness.value.getDetectionJobState).mockResolvedValue(canceling);

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledOnce());
        revision.value = 'revision-2';
        await nextTick();
        harness.emitDetection({
            ...detectionState('detect-1', 'canceled'),
            results: [],
            progress: canceling.progress,
            updatedAtMs: canceling.updatedAtMs + 1,
        });
        await run;

        expect(harness.value.start).not.toHaveBeenCalled();
        expect(mounted.session.run.inlineError.value)
            .toBe('scanCleanup.documentChangedBeforeRun');
        mounted.unmount();
    });

    it('starts cleanup from one atomic click-time request after detection cancellation', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`atomic-run-request-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        mounted.session.settings.values.outputMode = 'mixed';
        mounted.session.settings.values.thickness = 2;
        mounted.session.settings.values.marginsMm.leftMm = 7;
        mounted.session.selection.setSettingsScope('page');
        const canceling = {
            ...detectionState('detect-1', 'queued'),
            status: 'canceling' as const,
            updatedAtMs: Date.now() + 1,
        };
        vi.mocked(harness.value.getDetectionJobState).mockResolvedValue(canceling);
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'atomic-cleanup',
            outputPdfPath: '/managed/atomic-cleanup.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'atomic-cleanup',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 3,
        });

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledOnce());
        mounted.session.settings.values.outputMode = 'color';
        mounted.session.settings.values.thickness = -3;
        mounted.session.settings.values.marginsMm.leftMm = 12;
        harness.emitDetection({
            ...detectionState('detect-1', 'canceled'),
            results: [],
            progress: canceling.progress,
            updatedAtMs: canceling.updatedAtMs + 1,
        });
        await run;

        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({
            documentRevision: expect.any(String),
            sourcePdfPath: expect.stringContaining('atomic-run-request'),
            options: expect.objectContaining({
                outputMode: 'mixed',
                thickness: 2,
                marginsMm: expect.objectContaining({leftMm: 7}),
            }),
            sourcePageNumbers: [1],
        }));
        mounted.unmount();
    });

    it('surfaces a thrown cleanup bridge error through the owning workspace inline error', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`run-bridge-error-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection({
            ...detectionState('detect-1', 'canceled'),
            results: [],
            progress: {
                stage: 'detecting',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        vi.mocked(harness.value.start).mockRejectedValue(new Error('scan-cleanup IPC codec failed'));

        await mounted.session.run.run();

        expect(mounted.session.run.inlineError.value).toBe('scan-cleanup IPC codec failed');
        mounted.unmount();
    });

    it('keeps detection idle when the global run stops without the surface re-activating', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`run-stop-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        // A starting run cancels detection and takes the global run guard.
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        scanCleanupRun.inFlight = true;
        await nextTick();

        // Run completion hands off to the generated document; the source
        // workspace must not restart full-document detection the instant the
        // guard clears, or it races the output handoff.
        scanCleanupRun.inFlight = false;
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        expect(mounted.session.detection.pending.value).toBe(false);
        mounted.unmount();
    });

    it('does not suppress auto-detection when cancellation resolves after disposal', async () => {
        const harness = capabilityHarness();
        const cancellation = Promise.withResolvers<boolean>();
        vi.mocked(harness.value.cancelDetection).mockImplementation(() => cancellation.promise);
        capability.value = harness.value;
        const mounted = mountSession(`late-cancel-${Date.now()}`);

        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const cancelPromise = mounted.session.detection.cancel();
        mounted.unmount();
        cancellation.resolve(true);
        await cancelPromise;

        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
    });

    it('never treats canceled detection results as a fresh cache entry', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `canceled-cache-${Date.now()}`;
        const first = mountSession(documentKey);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        first.unmount();

        const reopened = mountSession(documentKey);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        reopened.unmount();
    });

    it('stores text-axis results and clears them before a fresh detection pass', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`text-axis-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const completed = detectionState('detect-1', 'completed');
        completed.results[0] = {
            ...completed.results[0]!,
            textAxis: {
                sideways: true,
                confidence: 0.98,
            },
        };
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(mounted.session.detection.textAxisByPage.get(1)).toEqual({
            sideways: true,
            confidence: 0.98,
        }));

        await vi.waitFor(() => expect(mounted.session.detection.canDetectAll.value).toBe(true));
        await mounted.session.detection.detectAllPages();
        expect(harness.value.detectAll).toHaveBeenCalledTimes(2);
        expect(mounted.session.detection.textAxisByPage.size).toBe(0);

        harness.emitDetection(completed);
        expect(mounted.session.detection.textAxisByPage.size).toBe(0);
        mounted.unmount();
    });

    it('preserves recommendations across output-mode changes and keeps them usable back in auto', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`output-mode-recommendation-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const completed = detectionState('detect-1', 'completed');
        completed.results[0] = {
            ...completed.results[0]!,
            recommendedOutputMode: 'color',
            recommendedOutputModeConfidence: 0.94,
            recommendedOutputModeReason: 'blank',
        };
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(
            mounted.session.detection.recommendedOutputModeByPage.get(1),
        ).toBe('color'));
        expect(mounted.session.detection.blankPageCount.value).toBe(1);

        mounted.session.settings.values.outputMode = 'bw';
        await nextTick();
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');
        expect(mounted.session.detection.recommendedOutputModeConfidenceByPage.get(1)).toBe(0.94);

        harness.emitDetection(completed);
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');

        mounted.session.settings.values.outputMode = 'auto';
        await nextTick();
        await nextTick();
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');
        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        mounted.unmount();
    });

    it('reschedules a canceled detection when switching back to automatic output mode', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`auto-mode-retry-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        await mounted.session.detection.cancel();
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        expect(mounted.session.detection.recommendedOutputModeByPage.size).toBe(0);

        mounted.session.settings.values.outputMode = 'bw';
        await nextTick();
        mounted.session.settings.values.outputMode = 'auto';
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        mounted.unmount();
    });

    it('retries a cleanup-canceled partial recommendation map when the source surface reactivates', async () => {
        const harness = capabilityHarness();
        const active = ref(true);
        capability.value = harness.value;
        const mounted = mountSession(`run-cancel-retry-${Date.now()}`, {active: () => active.value});

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const canceled = detectionState('detect-1', 'canceled');
        canceled.results = [{
            ...canceled.results[0]!,
            recommendedOutputMode: 'color',
            recommendedOutputModeConfidence: 0.91,
        }];
        canceled.progress = {
            ...canceled.progress,
            completedUnits: 1,
            completedPageNumbers: [1],
        };
        harness.emitDetection(canceled);
        expect(mounted.session.detection.recommendedOutputModeByPage.get(1)).toBe('color');

        active.value = false;
        await nextTick();
        active.value = true;

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
        mounted.unmount();
    });

    it('reopens with stored overrides, no cached recommendations, and repopulates from fresh detection', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `reopen-overrides-${Date.now()}`;
        const first = mountSession(documentKey);

        first.session.settings.values.pageOverrides['2'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            outputModeOverride: 'color',
        };
        await vi.waitFor(() => expect(JSON.parse(
            localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}',
        )[documentKey]?.overrides?.['2']?.outputModeOverride).toBe('color'));
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const firstCompleted = detectionState('detect-1', 'completed');
        firstCompleted.results[0] = {
            ...firstCompleted.results[0]!,
            recommendedOutputMode: 'bw',
            recommendedOutputModeConfidence: 0.92,
            recommendedOutputModeReason: 'bimodal-text',
        };
        harness.emitDetection(firstCompleted);
        await vi.waitFor(() => expect(
            first.session.detection.recommendedOutputModeByPage.get(1),
        ).toBe('bw'));
        first.unmount();

        const reopened = mountSession(documentKey);
        expect(reopened.session.settings.values.pageOverrides['2']?.outputModeOverride).toBe('color');
        expect(reopened.session.detection.recommendedOutputModeByPage.size).toBe(0);
        expect(reopened.session.detection.recommendedOutputModeConfidenceByPage.size).toBe(0);
        expect(reopened.session.detection.recommendedOutputModeReasonByPage.size).toBe(0);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));

        const refreshed = detectionState('detect-2', 'completed');
        refreshed.results[0] = {
            ...refreshed.results[0]!,
            recommendedOutputMode: 'mixed',
            recommendedOutputModeConfidence: 0.95,
            recommendedOutputModeReason: 'text-with-pictures',
        };
        harness.emitDetection(refreshed);
        await vi.waitFor(() => expect(
            reopened.session.detection.recommendedOutputModeByPage.get(1),
        ).toBe('mixed'));
        expect(reopened.session.detection.recommendedOutputModeConfidenceByPage.get(1)).toBe(0.95);
        expect(reopened.session.detection.recommendedOutputModeReasonByPage.get(1))
            .toBe('text-with-pictures');
        expect(reopened.session.settings.values.pageOverrides['2']?.outputModeOverride).toBe('color');
        reopened.unmount();
    });

    it('clears only the page recommendation whose picture or fill zones changed', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`zone-recommendation-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const completed = detectionState('detect-1', 'completed');
        completed.results[0] = {
            ...completed.results[0]!,
            recommendedOutputMode: 'mixed',
            recommendedOutputModeConfidence: 0.91,
        };
        completed.results[1] = {
            ...completed.results[1]!,
            recommendedOutputMode: 'bw',
            recommendedOutputModeConfidence: 0.87,
        };
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(
            mounted.session.detection.recommendedOutputModeByPage.size,
        ).toBe(2));

        mounted.session.settings.values.pageOverrides['1'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualZones: {
                picture: [],
                fill: [{
                    rotationDegrees: 0,
                    points: [
                        {
                            xNormalized: 0.1,
                            yNormalized: 0.1,
                        },
                        {
                            xNormalized: 0.2,
                            yNormalized: 0.1,
                        },
                        {
                            xNormalized: 0.2,
                            yNormalized: 0.2,
                        },
                    ],
                }],
            },
        };
        await nextTick();

        expect(mounted.session.detection.recommendedOutputModeByPage.has(1)).toBe(false);
        expect(mounted.session.detection.recommendedOutputModeConfidenceByPage.has(1)).toBe(false);
        expect(mounted.session.detection.recommendedOutputModeByPage.get(2)).toBe('bw');
        expect(mounted.session.detection.recommendedOutputModeConfidenceByPage.get(2)).toBe(0.87);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        mounted.unmount();
    });

    it('reschedules completed recommendations whenever page evidence changes', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`evidence-invalidation-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'completed'));

        mounted.session.settings.values.normalizeIllumination = false;
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        harness.emitDetection(detectionState('detect-2', 'completed'));

        // With normalization already disabled, preserve-quality used to collide
        // with the same derived signature and incorrectly retain the map.
        mounted.session.settings.values.preserveOriginalQuality = true;
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(3));
        harness.emitDetection(detectionState('detect-3', 'completed'));

        mounted.session.settings.values.pageOverrides['1'] = {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        };
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(4));
        harness.emitDetection(detectionState('detect-4', 'completed'));

        mounted.session.settings.values.pageOverrides['1'] = {
            ...mounted.session.settings.values.pageOverrides['1']!,
            excluded: true,
        };
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(5));
        harness.emitDetection(detectionState('detect-5', 'completed'));

        mounted.session.settings.values.pageOverrides['1'] = {
            ...mounted.session.settings.values.pageOverrides['1']!,
            excluded: false,
            manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.8,
                heightNormalized: 0.8,
                rotationDegrees: 90,
            }},
        };
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(6));
        mounted.unmount();
    });

    it('replaces a completed job when its evidence changed while detection was running', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`mid-detection-evidence-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        mounted.session.settings.values.pageOverrides['1'] = {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        };
        await nextTick();
        harness.emitDetection(detectionState('detect-1', 'completed'));

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        mounted.unmount();
    });

    it('invalidates the detected document canvas when layout or quality mode changes', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`canvas-plan-invalidation-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const completed = {
            ...detectionState('detect-1', 'completed'),
            documentCanvasPlan: {
                widthPoints: 420,
                heightPoints: 612,
            },
        };
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(mounted.session.detection.documentCanvasPlan.value)
            .toEqual(completed.documentCanvasPlan));

        mounted.session.settings.values.layoutMode = 'force-single';
        await nextTick();
        expect(mounted.session.detection.documentCanvasPlan.value).toBeUndefined();

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(harness.value.subscribeDetectionJob).toHaveBeenCalledTimes(2));
        harness.emitDetection({
            ...detectionState('detect-2', 'completed'),
            documentCanvasPlan: completed.documentCanvasPlan,
            updatedAtMs: Date.now() + 1,
        });
        await vi.waitFor(() => expect(mounted.session.detection.documentCanvasPlan.value)
            .toEqual(completed.documentCanvasPlan));
        mounted.session.settings.values.preserveOriginalQuality = true;
        await nextTick();
        expect(mounted.session.detection.documentCanvasPlan.value).toBeUndefined();
        mounted.unmount();
    });

    it('re-detects for each reopened owner and after detection settings change', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `stale-${Date.now()}`;
        const first = mountSession(documentKey);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'completed'));
        first.unmount();

        const fresh = mountSession(documentKey);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        fresh.unmount();

        getScanCleanupPreferencesStore().layoutMode = 'force-single';
        const stale = mountSession(documentKey);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(3));
        stale.unmount();
    });

    it('keeps placement-only changes in renderer geometry without requesting a sidecar preview', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`placement-${Date.now()}`);
        await vi.waitFor(() => expect(harness.value.preview).toHaveBeenCalled());
        await new Promise(resolve => setTimeout(resolve, 300));
        const previewCalls = vi.mocked(harness.value.preview).mock.calls.length;

        mounted.session.selection.updateCurrentPlacement('full', 'bottom-right');
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(vi.mocked(harness.value.preview).mock.calls.slice(previewCalls)).toEqual([]);
        mounted.unmount();
    });

    it('keeps the output estimate unchanged when a differing page preview arrives', async () => {
        const harness = capabilityHarness();
        const firstPreview = Promise.withResolvers<IScanCleanupPreviewResult>();
        vi.mocked(harness.value.preview).mockImplementation(async request => request.pageNumber === 1
            ? firstPreview.promise
            : previewResult(request.pageNumber, 'single-uncut-page'));
        capability.value = harness.value;
        const mounted = mountSession(`estimate-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(harness.value.preview).toHaveBeenCalled());
        harness.emitDetection({
            ...detectionState('detect-1', 'completed'),
            results: [
                {
                    pageNumber: 1,
                    classification: 'two-page-spread',
                    confidence: 0.92,
                    cutterXPx: 0.5,
                    tier1Verdict: 'single-uncut-page',
                    reconciled: true,
                    clusterAgreement: 0.8,
                    documentPrior: {
                        dominantLayout: 'two-page-spread',
                        cutterRatioMedian: 0.5,
                        clusterDims: {
                            widthPx: 1,
                            heightPx: 1,
                        },
                        agreementStrength: 0.8,
                    },
                },
                ...detectionState('detect-1', 'completed').results.slice(1),
            ],
        });
        await vi.waitFor(() => expect(mounted.session.detection.outputEstimate.value).toBe('scanCleanup.estimateExact:4'));
        const estimateBeforePreview = mounted.session.detection.outputEstimate.value;

        firstPreview.resolve(previewResult(1, 'single-uncut-page'));
        await vi.waitFor(() => expect(mounted.session.preview.result.value?.pageNumber).toBe(1));

        expect(mounted.session.detection.outputEstimate.value).toBe(estimateBeforePreview);
        expect(mounted.session.preview.classificationDiffersByPage.value.get(1)).toBe(true);
        mounted.unmount();
    });

    it('keeps detect-all authoritative after subsequent differing previews', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(async request => (
            previewResult(request.pageNumber, 'single-uncut-page')
        ));
        capability.value = harness.value;
        const mounted = mountSession(`authority-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection({
            ...detectionState('detect-1', 'completed'),
            results: [{
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.92,
                cutterXPx: 0.5,
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.8,
                documentPrior: {
                    dominantLayout: 'two-page-spread',
                    cutterRatioMedian: 0.5,
                    clusterDims: {
                        widthPx: 1,
                        heightPx: 1,
                    },
                    agreementStrength: 0.8,
                },
            }],
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 100 / 3,
                completedPageNumbers: [1],
            },
        });
        await vi.waitFor(() => expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1))
            .toBe('two-page-spread'));
        await vi.waitFor(() => expect(vi.mocked(harness.value.preview).mock.calls.some(
            ([request]) => request?.pageNumber === 1
                && request.documentPrior?.agreementStrength === 0.8,
        )).toBe(true));
        expect(mounted.session.detection.documentPriorByPage.get(1)).toMatchObject({
            dominantLayout: 'two-page-spread',
            cutterRatioMedian: 0.5,
        });
        const pageOnePreviewCalls = () => vi.mocked(harness.value.preview).mock.calls
            .filter(([request]) => request?.pageNumber === 1).length;
        const callsBeforeRetry = pageOnePreviewCalls();

        mounted.session.preview.retry();
        await vi.waitFor(() => expect(pageOnePreviewCalls()).toBeGreaterThan(callsBeforeRetry));

        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1)).toBe('two-page-spread');
        mounted.unmount();
    });

    it('keeps the page B preview cache key stable when only the page A override changes', () => {
        const before = scanCleanupOptions();
        const after = structuredClone(before);
        after.pageOverrides['1'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.8,
                heightNormalized: 0.8,
                rotationDegrees: 0,
            }},
        };

        expect(createScanCleanupPreviewCacheKey(1, after, '/document.pdf'))
            .not.toBe(createScanCleanupPreviewCacheKey(1, before, '/document.pdf'));
        expect(createScanCleanupPreviewCacheKey(2, after, '/document.pdf'))
            .toBe(createScanCleanupPreviewCacheKey(2, before, '/document.pdf'));
    });

    it('invalidates a page preview cache entry when its document prior changes', () => {
        const options = scanCleanupOptions();
        const prior = {
            dominantLayout: 'two-page-spread' as const,
            cutterRatioMedian: 0.5,
            clusterDims: {
                widthPx: 1200,
                heightPx: 871,
            },
            agreementStrength: 0.8,
        };

        expect(createScanCleanupPreviewCacheKey(1, options, '/document.pdf', 'rev', prior))
            .not.toBe(createScanCleanupPreviewCacheKey(1, options, '/document.pdf', 'rev', {
                ...prior,
                agreementStrength: 0.9,
            }));
    });

    it('keeps the cached page B preview valid after editing the page A override', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(async request => (
            previewResult(request.pageNumber, 'single-uncut-page')
        ));
        capability.value = harness.value;
        const mounted = mountSession(`page-cache-${Date.now()}`);

        await vi.waitFor(() => expect(vi.mocked(harness.value.preview).mock.calls.some(
            ([request]) => request?.pageNumber === 2,
        )).toBe(true));
        mounted.session.selection.selectPage(2, 'single', [
            1,
            2,
            3,
        ]);
        await vi.waitFor(() => expect(mounted.session.preview.result.value?.pageNumber).toBe(2));
        const cachedPageB = mounted.session.preview.result.value;
        const previewCallsBeforeEdit = vi.mocked(harness.value.preview).mock.calls.length;

        mounted.session.selection.updatePageOverride(1, {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualContentBoxes: {full: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.8,
                heightNormalized: 0.8,
                rotationDegrees: 0,
            }},
        });
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(vi.mocked(harness.value.preview)).toHaveBeenCalledTimes(previewCallsBeforeEdit);
        expect(mounted.session.preview.result.value).toBe(cachedPageB);
        mounted.unmount();
    });
});
