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
} from 'vue';
import type {
    IScanCleanupCapability,
    IScanCleanupOptions,
    IScanCleanupPreviewResult,
    TScanCleanupDetectionJobState,
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
        onJobState: vi.fn(() => () => undefined),
        onDetectionJobState: vi.fn(listener => {
            detectionListener = listener;
            return () => { detectionListener = () => undefined; };
        }),
    };
    return {
        emitDetection: (state: TScanCleanupDetectionJobState) => detectionListener(state),
        value,
    };
}

function mountSession(documentKey: string) {
    let session: ReturnType<typeof useScanCleanupWorkspaceSession> | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup() {
        session = useScanCleanupWorkspaceSession({
            active: () => true,
            sourcePath: () => `/docs/${documentKey}.pdf`,
            documentKey: () => documentKey,
            currentPage: () => 1,
            totalPages: () => 3,
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
    });

    afterEach(() => {
        capability.value = null;
    });

    it('auto-switches only for intentional multi-selection and its collapse', () => {
        capability.value = capabilityHarness().value;
        const mounted = mountSession(`scope-selection-${Date.now()}`);

        expect(mounted.session.selection.settingsScope.value).toBe('all');
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

        mounted.session.selection.selectPage(2, 'single', [
            1,
            2,
            3,
        ]);
        expect(mounted.session.selection.selectedPages.value).toEqual(new Set([2]));
        expect(mounted.session.selection.settingsScope.value).toBe('page');
        expect(mounted.session.selection.highlightedScope.value).toBe('page');

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

    it('shares global preference edits across mounted surfaces and persists their merged latest state', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const first = mountSession(`preferences-a-${Date.now()}`);
        const second = mountSession(`preferences-b-${Date.now()}`);

        first.session.settings.values.outputMode = 'color';
        expect(second.session.settings.values.outputMode).toBe('color');
        second.session.settings.values.readingOrder = 'rtl';
        expect(first.session.settings.values.readingOrder).toBe('rtl');

        await vi.waitFor(() => expect(JSON.parse(
            localStorage.getItem('evb.scanCleanup.settings.v1') ?? '{}',
        )).toMatchObject({
            outputMode: 'color',
            readingOrder: 'rtl',
        }));
        first.unmount();
        second.unmount();
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

    it('reuses fresh results but re-detects when the saved detection signature is stale', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `stale-${Date.now()}`;
        const first = mountSession(documentKey);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'completed'));
        first.unmount();

        const fresh = mountSession(documentKey);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        fresh.unmount();

        getScanCleanupPreferencesStore().layoutMode = 'force-single';
        const stale = mountSession(documentKey);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
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
            ([request]) => request.pageNumber === 1
                && request.documentPrior?.agreementStrength === 0.8,
        )).toBe(true));
        expect(mounted.session.detection.documentPriorByPage.get(1)).toMatchObject({
            dominantLayout: 'two-page-spread',
            cutterRatioMedian: 0.5,
        });
        const pageOnePreviewCalls = () => vi.mocked(harness.value.preview).mock.calls
            .filter(([request]) => request.pageNumber === 1).length;
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
            ([request]) => request.pageNumber === 2,
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
