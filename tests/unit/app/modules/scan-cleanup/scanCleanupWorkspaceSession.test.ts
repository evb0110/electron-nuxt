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
    IScanCleanupPagePlanEvidence,
    IScanCleanupPreviewResult,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
    TScanCleanupPageOutputMapping,
} from '@contracts/electronApiScanCleanup';
import type * as scanCleanupPageOverridesModule from '@contracts/scanCleanupPageOverrides';
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
import {
    getScanCleanupRunErrorCode,
    getScanCleanupRunError,
    scanCleanupRun,
    setScanCleanupRunError,
} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));
// Counts the real reduction rather than replacing it: the document's layouts
// are a pass over every page, and how often a session performs it is the thing
// under test in `derives the document's layouts once per change`.
const layoutReductions = vi.hoisted(() => ({count: 0}));

vi.mock('@contracts/scanCleanupPageOverrides', async importOriginal => {
    const original = await importOriginal<typeof scanCleanupPageOverridesModule>();
    return {
        ...original,
        toScanCleanupLayoutByPage: (
            ...args: Parameters<typeof original.toScanCleanupLayoutByPage>
        ) => {
            layoutReductions.count += 1;
            return original.toScanCleanupLayoutByPage(...args);
        },
    };
});
vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (
    key: string,
    values?: Record<string, unknown>,
) => {
    if (key === 'scanCleanup.detectAll.preAnalyzing') {
        return 'Pre-analyzing pages';
    }
    if (key === 'scanCleanup.runCount') {
        return `${String(values?.completed)} / ${String(values?.total)}`;
    }
    if (key === 'scanCleanup.runStatus') {
        return `${String(values?.phase)} — ${String(values?.counter)}`;
    }
    return values?.output === undefined ? key : `${key}:${String(values.output)}`;
}})}));

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
            ...(status === 'completed'
                ? {pagePlanEvidence: {
                    pageNumber: index + 1,
                    rotationDegrees: 0,
                    layoutClassification: 'single-uncut-page' as const,
                    outputs: {},
                } satisfies IScanCleanupPagePlanEvidence}
                : {}),
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

function failedDetectionState(
    jobId: string,
    errorCode: TScanCleanupErrorCode = 'internal',
): TScanCleanupDetectionJobState {
    return {
        ...detectionState(jobId, 'queued'),
        status: 'failed',
        error: 'uniform detection failed',
        errorCode,
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
    documentKey?: () => string | null;
    documentRevision?: () => string | null;
    initialPreviewPage?: () => number | undefined;
    pageMapping?: () => TScanCleanupPageOutputMapping | null | undefined;
    sourcePath?: () => string | null;
    sourceSha256?: () => string | null;
    totalPages?: () => number;
} = {}) {
    let session: ReturnType<typeof useScanCleanupWorkspaceSession> | null = null;
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup() {
        session = useScanCleanupWorkspaceSession({
            active: overrides.active ?? (() => true),
            sourcePath: overrides.sourcePath ?? (() => `/docs/${documentKey}.pdf`),
            documentKey: overrides.documentKey ?? (() => documentKey),
            ...(overrides.documentRevision === undefined
                ? {}
                : {documentRevision: overrides.documentRevision}),
            ...(overrides.sourceSha256 === undefined
                ? {}
                : {sourceSha256: overrides.sourceSha256}),
            currentPage: overrides.currentPage ?? (() => 1),
            totalPages: overrides.totalPages ?? (() => 3),
            ...(overrides.initialPreviewPage === undefined
                ? {}
                : {initialPreviewPage: overrides.initialPreviewPage}),
            ...(overrides.pageMapping === undefined
                ? {}
                : {pageMapping: overrides.pageMapping}),
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
        expect(mounted.session.detection.progressText.value).toBe('Pre-analyzing pages — 0 / 3');

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
        // Source rasters are only inputs. Reporting them as analyzed pages made
        // the visible counter change meaning when native results started.
        expect(mounted.session.detection.progressText.value).toBe('Pre-analyzing pages — 0 / 3');

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
            results: [{
                pageNumber: 2,
                classification: 'single-uncut-page',
                confidence: 0.9,
                cutterXPx: null,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
            }],
            updatedAtMs: Date.now() + 2_000,
        });
        await vi.waitFor(() => expect(settled.has(2)).toBe(true));
        expect([...settled].sort((left, right) => left - right)).toEqual([
            1,
            2,
            3,
        ]);
        expect(mounted.session.detection.progressText.value).toBe('Pre-analyzing pages — 1 / 3');
        expect(mounted.session.detection.progressWidestText.value).toBe('Pre-analyzing pages — 3 / 3');

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

    it('resets an out-of-range page-scoped selection when the document is replaced without mapping', async () => {
        capability.value = capabilityHarness().value;
        const revision = ref<string | null>('revision-1');
        const sourcePath = ref<string | null>('/docs/old.pdf');
        const totalPages = ref(6);
        const mounted = mountSession(`replacement-without-mapping-${Date.now()}`, {
            currentPage: () => 1,
            documentRevision: () => revision.value,
            pageMapping: () => undefined,
            sourcePath: () => sourcePath.value,
            totalPages: () => totalPages.value,
        });

        mounted.session.selection.selectPage(5, 'single', [
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        mounted.session.selection.setSettingsScope('page');
        mounted.session.selection.updateOutputModeOverride('color');

        revision.value = 'revision-2';
        sourcePath.value = '/docs/new.pdf';
        totalPages.value = 2;
        await nextTick();

        expect(mounted.session.selection.leader.value).toBe(1);
        expect([...mounted.session.selection.selectedPages.value]).toEqual([1]);
        expect(mounted.session.selection.settingsScope.value).toBe('all');
        expect([...mounted.session.selection.selectedPages.value].every(page => page <= 2)).toBe(true);
        expect(mounted.session.selection.currentPageOverride.value.outputModeOverride).toBeUndefined();

        mounted.unmount();
    });

    it('maps the selected page to the unique output page on replacement', async () => {
        capability.value = capabilityHarness().value;
        const revision = ref<string | null>('revision-1');
        const sourcePath = ref<string | null>('/docs/old.pdf');
        const totalPages = ref(6);
        const pageMapping: TScanCleanupPageOutputMapping = {'5': [2]};
        const mounted = mountSession(`replacement-with-mapping-${Date.now()}`, {
            currentPage: () => 1,
            documentRevision: () => revision.value,
            pageMapping: () => pageMapping,
            sourcePath: () => sourcePath.value,
            totalPages: () => totalPages.value,
        });

        mounted.session.selection.selectPage(5, 'single', [
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        mounted.session.selection.setSettingsScope('page');
        mounted.session.selection.updateOutputModeOverride('color');

        revision.value = 'revision-2';
        sourcePath.value = '/docs/new.pdf';
        totalPages.value = 2;
        await nextTick();

        expect(mounted.session.selection.leader.value).toBe(2);
        expect([...mounted.session.selection.selectedPages.value]).toEqual([2]);
        expect(mounted.session.selection.settingsScope.value).toBe('page');
        expect(mounted.session.selection.currentPageOverride.value.outputModeOverride).toBeUndefined();
        expect([...mounted.session.selection.selectedPages.value].every(page => page <= 2)).toBe(true);

        mounted.unmount();
    });

    it('resets page-scoped selection when replacement mapping is ambiguous', async () => {
        capability.value = capabilityHarness().value;
        const revision = ref<string | null>('revision-1');
        const sourcePath = ref<string | null>('/docs/old.pdf');
        const totalPages = ref(3);
        const pageMapping: TScanCleanupPageOutputMapping = {'2': [
            1,
            2,
        ]};
        const mounted = mountSession(`replacement-with-ambiguous-mapping-${Date.now()}`, {
            currentPage: () => 1,
            documentRevision: () => revision.value,
            pageMapping: () => pageMapping,
            sourcePath: () => sourcePath.value,
            totalPages: () => totalPages.value,
        });

        mounted.session.selection.selectPage(2, 'single', [
            1,
            2,
            3,
        ]);
        mounted.session.selection.setSettingsScope('page');
        mounted.session.selection.updateOutputModeOverride('color');

        revision.value = 'revision-2';
        sourcePath.value = '/docs/new.pdf';
        await nextTick();

        expect(mounted.session.selection.leader.value).toBe(1);
        expect([...mounted.session.selection.selectedPages.value]).toEqual([1]);
        expect(mounted.session.selection.settingsScope.value).toBe('all');
        expect(mounted.session.selection.currentPageOverride.value.outputModeOverride).toBeUndefined();

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

    it('uses final page completion to replace a run-paused preview instead of leaving it pending', async () => {
        const harness = capabilityHarness();
        const abandonedPreview = Promise.withResolvers<IScanCleanupPreviewResult>();
        let visibleRequests = 0;
        vi.mocked(harness.value.preview).mockImplementation(async request => {
            if (request.visible === true && request.pageNumber === 1) {
                visibleRequests += 1;
                if (visibleRequests === 1) {
                    return abandonedPreview.promise;
                }
            }
            return previewResult(request.pageNumber, 'single-uncut-page');
        });
        capability.value = harness.value;
        const documentKey = `run-page-preview-handoff-${Date.now()}`;
        const sourcePath = `/docs/${documentKey}.pdf`;
        const mounted = mountSession(documentKey);

        await vi.waitFor(() => expect(visibleRequests).toBe(1));
        mounted.session.preview.pauseForRun();
        expect(mounted.session.preview.loading.value).toBe(false);
        expect(mounted.session.preview.result.value).toBeNull();

        scanCleanupRun.activeJobId = 'cleanup-page-handoff';
        scanCleanupRun.ownerDocumentRef = sourcePath;
        scanCleanupRun.ownerDocumentRevision = documentKey;
        scanCleanupRun.ownerId = mounted.session.run.ownerId;
        scanCleanupRun.jobState = {
            jobId: 'cleanup-page-handoff',
            status: 'running',
            progress: {
                stage: 'rendering',
                completedUnits: 1,
                totalUnits: 3,
                percent: 33,
                completedPageNumbers: [1],
            },
            updatedAtMs: Date.now(),
        };

        await vi.waitFor(() => expect(visibleRequests).toBe(2));
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));
        expect(mounted.session.preview.result.value?.pageNumber).toBe(1);

        // Coalesced progress for the same completed page cannot start another
        // preview generation.
        scanCleanupRun.jobState = {
            ...scanCleanupRun.jobState,
            updatedAtMs: Date.now() + 1,
        } as TScanCleanupJobState;
        await nextTick();
        expect(visibleRequests).toBe(2);
        mounted.unmount();
    });

    it('derives the document\'s layouts once per change, not once per request', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(
            async request => previewResult(request.pageNumber, 'single-uncut-page'),
        );
        capability.value = harness.value;
        const mounted = mountSession(`layout-reductions-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));
        // Each page previewed also queues its neighbours and keys them, and each
        // of those asked the whole document for its layouts before this was
        // derived once per change of them.
        await vi.waitFor(() => expect(vi.mocked(harness.value.preview).mock.calls.length)
            .toBeGreaterThan(1));
        const afterFirstPage = layoutReductions.count;

        mounted.session.preview.navigate(1);
        await vi.waitFor(() => expect(mounted.session.preview.result.value?.pageNumber).toBe(2));
        mounted.session.preview.navigate(1);
        await vi.waitFor(() => expect(mounted.session.preview.result.value?.pageNumber).toBe(3));

        // Nothing classified a page in between, so navigating cost no further
        // pass over the document.
        expect(layoutReductions.count).toBe(afterFirstPage);
        mounted.unmount();
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
        mounted.session.settings.values.outputMode = 'bw';
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
        mounted.session.settings.values.outputMode = 'bw';
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

    it('rebuilds the base preview after the wrapped IPC detail-geometry error', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(async request => {
            if (request.detail) {
                throw new Error(
                    'Error invoking remote method \'x\': Error: '
                    + 'Scan cleanup detail geometry is unavailable; rebuild the base preview',
                );
            }
            return previewResult(request.pageNumber, 'single-uncut-page');
        });
        capability.value = harness.value;
        const mounted = mountSession(`detail-stale-base-${Date.now()}`);
        mounted.session.settings.values.outputMode = 'bw';
        await vi.waitFor(() => expect(mounted.session.preview.resultCurrent.value).toBe(true));
        const baseCallsBefore = vi.mocked(harness.value.preview).mock.calls
            .filter(([request]) => request?.pageNumber === 1 && !request.detail).length;

        await mounted.session.preview.requestDetail({full: {
            xNormalized: 0,
            yNormalized: 0,
            widthNormalized: 1,
            heightNormalized: 1,
            rotationDegrees: 0,
        }});

        await vi.waitFor(() => expect(vi.mocked(harness.value.preview).mock.calls
            .filter(([request]) => request?.pageNumber === 1 && !request.detail)).toHaveLength(baseCallsBefore + 1));
        expect(vi.mocked(harness.value.preview).mock.calls.filter(([request]) => request?.detail))
            .toHaveLength(1);
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
        mounted.session.settings.values.outputMode = 'bw';
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
        await nextTick();
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

    it('coalesces document setting writes and flushes the old document before switching', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const firstKey = `debounced-preferences-a-${Date.now()}`;
        const secondKey = `debounced-preferences-b-${Date.now()}`;
        const documentKey = ref(firstKey);
        const mounted = mountSession(firstKey, {documentKey: () => documentKey.value});
        await nextTick();
        const setItem = vi.spyOn(localStorage, 'setItem');
        const documentWrites = () => setItem.mock.calls.filter(([key]) => (
            key === 'evb.scanCleanup.documentOverrides.v1'
        )).length;

        mounted.session.settings.values.pageOverrides['1'] = {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        };
        mounted.session.settings.values.marginsMm.leftMm = 8;
        mounted.session.settings.values.outputMode = 'color';
        await nextTick();
        expect(documentWrites()).toBe(0);
        await vi.waitFor(() => expect(documentWrites()).toBe(1));
        const persisted = JSON.parse(localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}');
        expect(persisted[firstKey]).toMatchObject({
            outputMode: 'color',
            marginsMm: {leftMm: 8},
            overrides: {'1': expect.any(Object)},
        });

        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        expect(documentWrites()).toBe(1);
        documentKey.value = secondKey;
        await nextTick();
        expect(documentWrites()).toBe(2);
        expect(JSON.parse(localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}'))
            .toMatchObject({[firstKey]: {outputMode: 'grayscale'}});

        setItem.mockRestore();
        mounted.unmount();
    });

    it('keeps unchanged page evidence signatures stable after another page changes', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`signature-stability-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await vi.waitFor(() => expect(scanCleanupDetectionSessionCache.size).toBe(1));
        const before = [...scanCleanupDetectionSessionCache.values()][0]?.signatures;
        expect(before).toBeDefined();

        mounted.session.settings.values.pageOverrides['2'] = {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        };
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        harness.emitDetection(detectionState('detect-2', 'completed'));
        await vi.waitFor(() => expect(
            [...scanCleanupDetectionSessionCache.values()][0]?.signatures.get(2),
        ).not.toBe(before?.get(2)));
        const after = [...scanCleanupDetectionSessionCache.values()][0]?.signatures;
        expect(after?.get(1)).toBe(before?.get(1));
        expect(after?.get(3)).toBe(before?.get(3));
        mounted.unmount();
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

    it('retires a deferred detection start when only the document revision changes', async () => {
        const harness = capabilityHarness();
        const revision = ref('revision-1');
        const staleStart = Promise.withResolvers<Awaited<ReturnType<IScanCleanupCapability['detectAll']>>>();
        vi.mocked(harness.value.detectAll)
            .mockImplementationOnce(() => staleStart.promise)
            .mockResolvedValueOnce({
                started: true,
                jobId: 'detect-revision-2',
            });
        capability.value = harness.value;
        const mounted = mountSession(
            `deferred-revision-${Date.now()}`,
            {documentRevision: () => revision.value},
        );

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        revision.value = 'revision-2';
        await nextTick();
        staleStart.resolve({
            started: true,
            jobId: 'detect-revision-1',
        });

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledWith(
            'detect-revision-1',
            {
                ownerId: mounted.session.run.ownerId,
                documentRevision: 'revision-1',
            },
        ));
        expect(harness.value.detectAll).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({documentRevision: 'revision-2'}),
        );
        expect(harness.value.subscribeDetectionJob).toHaveBeenCalledOnce();
        expect(harness.value.subscribeDetectionJob).toHaveBeenCalledWith(
            'detect-revision-2',
            {
                ownerId: mounted.session.run.ownerId,
                documentRevision: 'revision-2',
            },
        );
        expect(harness.value.subscribeDetectionJob).not.toHaveBeenCalledWith(
            'detect-revision-1',
            expect.anything(),
        );
        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        expect(mounted.session.detection.authoritativeLayoutByPage.value.size).toBe(0);
        expect(mounted.session.detection.isDetecting.value).toBe(true);
        mounted.unmount();
    });

    it('reconciles a rejected detection subscription and abandons an unobservable job', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.subscribeDetectionJob).mockRejectedValue(
            new Error('detection subscription transport failed'),
        );
        capability.value = harness.value;
        const mounted = mountSession(`unobservable-detection-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.subscribeDetectionJob).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));

        expect(harness.value.getDetectionJobState).toHaveBeenCalledTimes(3);
        expect(harness.value.cancelDetection).toHaveBeenCalledWith(
            'detect-1',
            expect.objectContaining({documentRevision: expect.any(String)}),
        );
        expect(mounted.session.detection.isDetecting.value).toBe(false);
        expect(mounted.session.detection.error.value).toContain('could not be observed');
        mounted.unmount();
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

    it('queues an Auto cleanup click until every included page has a durable mode decision', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`auto-decision-lock-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const partialResultAt = Date.now() + 1_000;
        harness.emitDetection({
            jobId: 'detect-1',
            status: 'running',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 100 / 3,
                completedPageNumbers: [1],
            },
            results: [{
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.94,
                cutterXPx: 100,
                tier1Verdict: 'two-page-spread',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
                recommendedOutputMode: 'bw',
                sourcePageMetadata: {
                    pageNumber: 1,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 612,
                    heightPoints: 792,
                    rotation: 0,
                    sourceDpi: 300,
                },
            }],
            updatedAtMs: partialResultAt,
        });
        await vi.waitFor(() => expect(mounted.session.detection.progressText.value)
            .toBe('Pre-analyzing pages — 1 / 3'));
        expect(mounted.session.run.canRun.value).toBe(true);
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-auto-lock',
            outputPdfPath: '/managed/cleanup-after-auto-lock.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-auto-lock',
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
        await vi.waitFor(() => expect(mounted.session.run.transitionText.value)
            .toBe('Pre-analyzing pages'));
        expect(mounted.session.run.isRunning.value).toBe(true);
        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).not.toHaveBeenCalled();

        const completed = detectionState('detect-1', 'completed');
        completed.results = completed.results.map(result => ({
            ...result,
            recommendedOutputMode: result.pageNumber === 1 ? 'bw' : 'grayscale',
        }));
        completed.updatedAtMs = partialResultAt + 1;
        harness.emitDetection(completed);
        await run;
        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).toHaveBeenCalledOnce();
        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({outputModeRecommendations: {
            '1': 'bw',
            '2': 'grayscale',
            '3': 'grayscale',
        }}));
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
        mounted.unmount();
    });

    it('cancels a queued Auto cleanup attempt without canceling pre-analysis', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`auto-decision-cancel-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection({
            ...detectionState('detect-1', 'queued'),
            status: 'running',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 3,
                percent: 100 / 3,
                completedPageNumbers: [1],
            },
            results: [{
                ...detectionState('detect-1', 'completed').results[0]!,
                recommendedOutputMode: 'bw',
            }],
            updatedAtMs: Date.now() + 1_000,
        });
        await vi.waitFor(() => expect(mounted.session.detection.progressText.value)
            .toBe('Pre-analyzing pages — 1 / 3'));

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(mounted.session.run.transitionText.value)
            .toBe('Pre-analyzing pages'));
        await mounted.session.run.cancel();
        await run;

        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).not.toHaveBeenCalled();
        expect(mounted.session.detection.isDetecting.value).toBe(true);
        expect(mounted.session.run.isRunning.value).toBe(false);
        expect(mounted.session.run.cancelRequested.value).toBe(false);
        expect(mounted.session.run.canRun.value).toBe(true);
        mounted.unmount();
    });

    it('waits for a complete detection pass for a non-auto run', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`wait-before-start-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-wait',
            outputPdfPath: '/managed/cleanup-after-wait.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-wait',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(mounted.session.run.transitionText.value)
            .toBe('Pre-analyzing pages'));
        expect(mounted.session.run.isRunning.value).toBe(true);
        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).not.toHaveBeenCalled();

        harness.emitDetection(detectionState('detect-1', 'completed'));
        await run;

        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).toHaveBeenCalledOnce();
        mounted.unmount();
    });

    it('keeps run-owned detection alive when its cleanup tab becomes inactive', async () => {
        const harness = capabilityHarness();
        const active = ref(true);
        const documentKey = `hidden-run-detection-${Date.now()}`;
        capability.value = harness.value;
        const mounted = mountSession(documentKey, {active: () => active.value});
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-hidden-detection',
            outputPdfPath: '/managed/cleanup-after-hidden-detection.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-hidden-detection',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(mounted.session.run.waitingForDetection.value).toBe(true));
        vi.mocked(harness.value.cancelPreview).mockClear();
        active.value = false;
        await nextTick();

        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.cancelPreview).toHaveBeenCalledWith(expect.objectContaining({
            documentRevision: documentKey,
            invalidateRawCache: false,
            ownerId: mounted.session.run.ownerId,
            sourcePdfPath: expect.stringContaining('hidden-run-detection'),
        }));
        expect(harness.value.start).not.toHaveBeenCalled();

        harness.emitDetection(detectionState('detect-1', 'completed'));
        await run;

        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).toHaveBeenCalledOnce();
        expect(getScanCleanupRunError(mounted.session.run.ownerId)).toBe('');
        mounted.unmount();
    });

    it('starts and waits for scheduled replacement detection when Run lands in the empty-state turn', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`run-before-scheduled-detection-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await vi.waitFor(() => expect(mounted.session.detection.terminalStatus.value).toBe('completed'));
        mounted.session.settings.values.outputMode = 'grayscale';
        mounted.session.settings.values.marginsMm.leftMm = 6;
        await nextTick();

        // Invalidating evidence clears the terminal snapshot and schedules a
        // replacement for the next timer turn. This used to look idle to Run,
        // which immediately surfaced evidenceMissing without starting work.
        expect(mounted.session.detection.terminalStatus.value).toBeNull();
        expect(mounted.session.detection.pending.value).toBe(false);
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-scheduled-detection',
            outputPdfPath: '/managed/cleanup-after-scheduled-detection.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-scheduled-detection',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        const run = mounted.session.run.run();
        await nextTick();

        expect(mounted.session.run.transitionText.value).toBe('Pre-analyzing pages');
        expect(mounted.session.run.isRunning.value).toBe(true);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        expect(harness.value.start).not.toHaveBeenCalled();

        harness.emitDetection(detectionState('detect-2', 'completed'));
        await run;

        expect(getScanCleanupRunError(mounted.session.run.ownerId)).toBe('');
        expect(harness.value.start).toHaveBeenCalledOnce();
        mounted.unmount();
    });

    it('follows a run-owned detection replaced by authoritative source identity', async () => {
        const harness = capabilityHarness();
        const sourceSha256 = ref<string | null>(null);
        const deferredDetection = Promise.withResolvers<{
            started: true;
            jobId: string;
        }>();
        capability.value = harness.value;
        const mounted = mountSession(`run-during-source-identity-${Date.now()}`, {
            documentRevision: () => 'revision-1',
            sourceSha256: () => sourceSha256.value,
        });
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await vi.waitFor(() => expect(mounted.session.detection.terminalStatus.value).toBe('completed'));
        vi.mocked(harness.value.detectAll)
            .mockImplementationOnce(() => deferredDetection.promise)
            .mockResolvedValueOnce({
                started: true,
                jobId: 'detect-authoritative-source',
            });
        mounted.session.settings.values.outputMode = 'grayscale';
        mounted.session.settings.values.marginsMm.leftMm = 6;
        await nextTick();
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-after-source-identity',
            outputPdfPath: '/managed/cleanup-after-source-identity.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-after-source-identity',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        expect(mounted.session.run.transitionText.value).toBe('Pre-analyzing pages');

        sourceSha256.value = 'c'.repeat(64);
        await nextTick();
        deferredDetection.resolve({
            started: true,
            jobId: 'detect-legacy-source',
        });

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(3));
        expect(harness.value.cancelDetection).toHaveBeenCalledWith('detect-legacy-source', {
            ownerId: mounted.session.run.ownerId,
            documentRevision: 'revision-1',
        });
        expect(harness.value.start).not.toHaveBeenCalled();

        harness.emitDetection(detectionState('detect-authoritative-source', 'completed'));
        await run;

        expect(harness.value.detectAll).toHaveBeenCalledTimes(3);
        expect(mounted.session.detection.terminalStatus.value).toBe('completed');
        expect(mounted.session.detection.pagePlanEvidenceByPage.size).toBe(3);
        expect(getScanCleanupRunError(mounted.session.run.ownerId)).toBe('');
        expect(harness.value.start).toHaveBeenCalledOnce();
        mounted.unmount();
    });

    it('rejects a stale completed status synchronously when Run follows a document switch', async () => {
        const harness = capabilityHarness();
        const sourcePath = ref('/docs/immediate-run-first.pdf');
        const documentKey = ref('immediate-run-first');
        capability.value = harness.value;
        const mounted = mountSession('immediate-run-first', {
            documentKey: () => documentKey.value,
            documentRevision: () => 'shared-revision',
            sourcePath: () => sourcePath.value,
        });
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await vi.waitFor(() => expect(mounted.session.detection.terminalStatus.value).toBe('completed'));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-second-document',
            outputPdfPath: '/managed/cleanup-second-document.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-second-document',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        sourcePath.value = '/docs/immediate-run-second.pdf';
        documentKey.value = 'immediate-run-second';

        // Computed identity changes before the lifecycle watcher gets its
        // queued flush; the prior document's completed snapshot must already
        // be ineligible for the new document's Run click.
        expect(mounted.session.detection.terminalStatus.value).toBeNull();
        const run = mounted.session.run.run();
        expect(mounted.session.run.transitionText.value).toBe('Pre-analyzing pages');
        expect(harness.value.start).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        harness.emitDetection(detectionState('detect-2', 'completed'));
        await run;

        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({sourcePdfPath: '/docs/immediate-run-second.pdf'}));
        expect(getScanCleanupRunError(mounted.session.run.ownerId)).toBe('');
        mounted.unmount();
    });

    it('serializes lifecycle replacement detection behind the exact old cancellation', async () => {
        const harness = capabilityHarness();
        const sourceSha256 = ref<string | null>(null);
        const deferredCancellation = Promise.withResolvers<boolean>();
        capability.value = harness.value;
        const mounted = mountSession(`serialized-detection-retirement-${Date.now()}`, {
            documentRevision: () => 'revision-1',
            sourceSha256: () => sourceSha256.value,
        });
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        vi.mocked(harness.value.cancelDetection).mockImplementationOnce(() => deferredCancellation.promise);

        sourceSha256.value = 'd'.repeat(64);
        await nextTick();
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledWith('detect-1', {
            ownerId: mounted.session.run.ownerId,
            documentRevision: 'revision-1',
        }));
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        expect(mounted.session.detection.terminalStatus.value).toBeNull();

        deferredCancellation.resolve(true);
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));

        expect(mounted.session.detection.isDetecting.value).toBe(true);
        expect(mounted.session.detection.terminalStatus.value).toBeNull();
        harness.emitDetection(detectionState('detect-2', 'completed'));
        await vi.waitFor(() => expect(mounted.session.detection.terminalStatus.value).toBe('completed'));
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(harness.value.detectAll).toHaveBeenCalledTimes(2);
        mounted.unmount();
    });

    it('reports canceled detection as a typed run error', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`canceled-before-run-${Date.now()}`);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();

        await mounted.session.run.run();

        expect(harness.value.start).not.toHaveBeenCalled();
        expect(getScanCleanupRunError(mounted.session.run.ownerId))
            .toBe('scanCleanup.detectAll.evidenceMissing');
        expect(getScanCleanupRunErrorCode(mounted.session.run.ownerId)).toBe('canceled');
        mounted.unmount();
    });

    it('rejects a revision-changed run after the detection lifecycle retires its job', async () => {
        const harness = capabilityHarness();
        const revision = ref('revision-1');
        capability.value = harness.value;
        const mounted = mountSession(
            `revision-during-cancel-${Date.now()}`,
            {documentRevision: () => revision.value},
        );
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        const run = mounted.session.run.run();
        await vi.waitFor(() => expect(mounted.session.run.transitionText.value)
            .toBe('Pre-analyzing pages'));
        revision.value = 'revision-2';
        await nextTick();
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await run;

        // Changing the source revision retires the detection session itself;
        // the cleanup run still only waits and then rejects its stale click.
        expect(harness.value.cancelDetection).toHaveBeenCalledOnce();
        expect(harness.value.cancelDetection).toHaveBeenCalledWith('detect-1', {
            ownerId: mounted.session.run.ownerId,
            documentRevision: 'revision-1',
        });
        expect(harness.value.start).not.toHaveBeenCalled();
        expect(getScanCleanupRunError(mounted.session.run.ownerId))
            .toBe('scanCleanup.documentChangedBeforeRun');
        mounted.unmount();
    });

    it('retires a deferred detect-all request and starts the replacement revision', async () => {
        const harness = capabilityHarness();
        const revision = ref('revision-1');
        const deferred = Promise.withResolvers<{
            started: true;
            jobId: string;
        }>();
        vi.mocked(harness.value.detectAll)
            .mockImplementationOnce(() => deferred.promise)
            .mockResolvedValueOnce({
                started: true,
                jobId: 'detect-revision-2',
            });
        capability.value = harness.value;
        const documentKey = `revision-during-detect-all-${Date.now()}`;
        const mounted = mountSession(documentKey, {documentRevision: () => revision.value});

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        revision.value = 'revision-2';
        await nextTick();
        deferred.resolve({
            started: true,
            jobId: 'detect-revision-1',
        });

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        expect(harness.value.cancelDetection).toHaveBeenCalledWith('detect-revision-1', {
            ownerId: mounted.session.run.ownerId,
            documentRevision: 'revision-1',
        });
        expect(harness.value.subscribeDetectionJob).not.toHaveBeenCalledWith(
            'detect-revision-1',
            expect.anything(),
        );
        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        expect(harness.value.detectAll).toHaveBeenLastCalledWith(expect.objectContaining({documentRevision: 'revision-2'}));
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(harness.value.detectAll).toHaveBeenCalledTimes(2);
        mounted.unmount();
    });

    it('surfaces a failed run after the document workspace remounts with a new owner', async () => {
        const harness = capabilityHarness();
        const revision = ref('revision-1');
        const documentKey = `persisted-run-error-${Date.now()}`;
        const sourcePath = `/docs/${documentKey}.pdf`;
        capability.value = harness.value;
        const first = mountSession(documentKey, {documentRevision: () => revision.value});
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        setScanCleanupRunError(
            first.session.run.ownerId,
            'Native cleanup failed',
            'internal',
            sourcePath,
            revision.value,
        );
        first.unmount();

        const second = mountSession(documentKey, {documentRevision: () => revision.value});
        expect(second.session.run.error.value).toBe('Native cleanup failed');
        expect(second.session.run.errorCode.value).toBe('internal');
        expect(second.session.run.ownerId).not.toBe(first.session.run.ownerId);

        revision.value = 'revision-2';
        await nextTick();
        expect(second.session.run.error.value).toBe('');
        revision.value = 'revision-1';
        await nextTick();
        expect(second.session.run.error.value).toBe('Native cleanup failed');
        second.session.run.dismissError();
        expect(second.session.run.error.value).toBe('');
        second.unmount();
    });

    it('starts cleanup from one atomic click-time request after detection completes', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`atomic-run-request-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        mounted.session.settings.values.outputMode = 'mixed';
        mounted.session.settings.values.thickness = 2;
        mounted.session.selection.setSettingsScope('page');
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
        await vi.waitFor(() => expect(mounted.session.run.transitionText.value)
            .toBe('Pre-analyzing pages'));
        mounted.session.settings.values.outputMode = 'color';
        mounted.session.settings.values.thickness = -3;
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await run;

        expect(harness.value.cancelDetection).not.toHaveBeenCalled();
        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({
            documentRevision: expect.any(String),
            sourcePdfPath: expect.stringContaining('atomic-run-request'),
            options: expect.objectContaining({
                outputMode: 'mixed',
                thickness: 2,
                marginsMm: expect.objectContaining({leftMm: 5}),
            }),
            sourcePageNumbers: [1],
        }));
        mounted.unmount();
    });

    it('uses detection-owned page evidence when resolving a run', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`uniform-run-evidence-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        const detectionEvidence: IScanCleanupPagePlanEvidence = {
            pageNumber: 1,
            rotationDegrees: 0,
            layoutClassification: 'single-uncut-page',
            automaticSplit: {
                xNormalized: 0.42,
                rotationDegrees: 0,
            },
            outputs: {},
        };
        const completed = detectionState('detect-1', 'completed');
        completed.results[0] = {
            ...completed.results[0]!,
            pagePlanEvidence: detectionEvidence,
        };
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-with-uniform-evidence',
            outputPdfPath: '/managed/cleanup-with-uniform-evidence.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-with-uniform-evidence',
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

        await mounted.session.run.run();

        const expectedEvidenceByPage = expect.objectContaining({'1': detectionEvidence});
        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({pagePlanEvidenceByPage: expectedEvidenceByPage}));
        mounted.unmount();
    });

    it('records a thrown cleanup bridge error for the global toast coordinator', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`run-bridge-error-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection(detectionState('detect-1', 'completed'));
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        mounted.session.settings.values.outputMode = 'grayscale';
        await nextTick();
        vi.mocked(harness.value.start).mockRejectedValue(new Error('scan-cleanup IPC codec failed'));

        await mounted.session.run.run();

        expect(getScanCleanupRunError(mounted.session.run.ownerId))
            .toBe('scan-cleanup IPC codec failed');
        mounted.unmount();
    });

    it('reports failed detection with its typed error code', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`failed-detection-run-${Date.now()}`);
        await vi.waitFor(() => expect(mounted.session.detection.isDetecting.value).toBe(true));
        harness.emitDetection(failedDetectionState('detect-1', 'native-failure'));
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));

        await mounted.session.run.run();

        expect(harness.value.start).not.toHaveBeenCalled();
        expect(getScanCleanupRunError(mounted.session.run.ownerId))
            .toBe('uniform detection failed');
        expect(getScanCleanupRunErrorCode(mounted.session.run.ownerId)).toBe('native-failure');
        mounted.unmount();
    });

    it('keeps detection idle when the global run stops without the surface re-activating', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`run-stop-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        // A terminal detection state is delivered before the global run guard.
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        scanCleanupRun.inFlight = true;
        await nextTick();

        // Run completion hands off to the generated document; the source
        // workspace must not restart full-document detection the instant the
        // guard clears, or it races the output handoff.
        scanCleanupRun.inFlight = false;
        await nextTick();
        await nextTick();

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

    it('pins completed detection plans for every page into the final run', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const mounted = mountSession(`detection-page-plans-${Date.now()}`);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const completed = detectionState('detect-1', 'completed');
        completed.results = completed.results.map(result => ({
            ...result,
            recommendedOutputMode: 'grayscale',
            pagePlanEvidence: {
                pageNumber: result.pageNumber,
                rotationDegrees: 0,
                layoutClassification: result.classification,
                outputs: {},
            },
        }));
        harness.emitDetection(completed);
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        vi.mocked(harness.value.start).mockResolvedValue({
            started: true,
            jobId: 'cleanup-with-detection-plans',
            outputPdfPath: '/managed/cleanup-with-detection-plans.pdf',
        });
        vi.mocked(harness.value.subscribeJob).mockResolvedValue({
            jobId: 'cleanup-with-detection-plans',
            status: 'canceled',
            progress: {
                stage: 'queued',
                completedUnits: 0,
                totalUnits: 3,
                percent: 0,
                completedPageNumbers: [],
            },
            updatedAtMs: Date.now() + 1,
        });

        await mounted.session.run.run();

        expect(harness.value.start).toHaveBeenCalledWith(expect.objectContaining({pagePlanEvidenceByPage: {
            '1': expect.objectContaining({pageNumber: 1}),
            '2': expect.objectContaining({pageNumber: 2}),
            '3': expect.objectContaining({pageNumber: 3}),
        }}));
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

    it('cancels hidden-tab preview and detection, then resumes with the same owner and SHA identity', async () => {
        const harness = capabilityHarness();
        const active = ref(true);
        const sourceSha256 = 'b'.repeat(64);
        capability.value = harness.value;
        vi.mocked(harness.value.getDetectionJobState).mockImplementation(async jobId => (
            detectionState(jobId, 'canceled')
        ));
        const mounted = mountSession(`hidden-tab-${Date.now()}`, {
            active: () => active.value,
            documentRevision: () => 'stable-revision',
            sourceSha256: () => sourceSha256,
        });

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        const ownerId = mounted.session.run.ownerId;
        expect(scanCleanupRun.workspaceOwnerIds.has(ownerId)).toBe(true);

        active.value = false;
        await nextTick();

        expect(scanCleanupRun.workspaceOwnerIds.has(ownerId)).toBe(false);
        await vi.waitFor(() => expect(harness.value.cancelDetection).toHaveBeenCalledWith(
            'detect-1',
            {
                ownerId,
                documentRevision: 'stable-revision',
            },
        ));
        expect(harness.value.cancelPreview).toHaveBeenCalledWith(expect.objectContaining({
            documentRevision: 'stable-revision',
            invalidateRawCache: false,
            ownerId,
            sourcePdfPath: expect.stringContaining('hidden-tab'),
        }));

        active.value = true;
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));

        expect(mounted.session.run.ownerId).toBe(ownerId);
        expect(scanCleanupRun.workspaceOwnerIds.has(ownerId)).toBe(true);
        expect(harness.value.detectAll).toHaveBeenLastCalledWith(expect.objectContaining({
            documentRevision: 'stable-revision',
            ownerId,
            sourcePdfPath: expect.stringContaining('hidden-tab'),
        }));
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

    it('reschedules completed recommendations only when detection evidence changes', async () => {
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
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(harness.value.detectAll).toHaveBeenCalledTimes(4);
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1))
            .toBe('single-uncut-page');

        mounted.session.settings.values.pageOverrides['1'] = {
            ...mounted.session.settings.values.pageOverrides['1']!,
            excluded: false,
            manualContentBoxes: {right: {
                xNormalized: 0.55,
                yNormalized: 0.1,
                widthNormalized: 0.35,
                heightNormalized: 0.8,
                rotationDegrees: 90,
            }},
        };
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(harness.value.detectAll).toHaveBeenCalledTimes(4);
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1))
            .toBe('single-uncut-page');
        mounted.unmount();
    });

    it('keeps a right-half manual crop through preview refresh and later detection results', async () => {
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(async request => (
            previewResult(request.pageNumber, 'two-page-spread')
        ));
        capability.value = harness.value;
        const mounted = mountSession(`manual-crop-detection-${Date.now()}`);
        const automaticRight = (xNormalized: number): IScanCleanupPagePlanEvidence => ({
            pageNumber: 1,
            rotationDegrees: 0,
            layoutClassification: 'two-page-spread',
            automaticSplit: {
                xNormalized: 0.5,
                rotationDegrees: 0,
            },
            outputs: {right: {contentBox: {
                xNormalized,
                yNormalized: 0.05,
                widthNormalized: 0.4,
                heightNormalized: 0.9,
                rotationDegrees: 0,
            }}},
        });
        const completedSpread = (jobId: string, xNormalized: number): TScanCleanupDetectionJobState => {
            const state = detectionState(jobId, 'completed');
            state.results[0] = {
                ...state.results[0]!,
                classification: 'two-page-spread',
                cutterXPx: 500,
                tier1Verdict: 'two-page-spread',
                pagePlanEvidence: automaticRight(xNormalized),
            };
            return state;
        };
        const visiblePageOneRequests = () => vi.mocked(harness.value.preview).mock.calls
            .flatMap(([request]) => request?.pageNumber === 1 && request.visible === true
                ? [request]
                : []);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        harness.emitDetection(completedSpread('detect-1', 0.52));
        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        await vi.waitFor(() => expect(visiblePageOneRequests().length).toBeGreaterThan(0));
        const previewRequestsBeforeManualCrop = visiblePageOneRequests().length;
        const retainedEvidence = mounted.session.detection.pagePlanEvidenceByPage.get(1);
        const manualRight = {
            xNormalized: 0.6,
            yNormalized: 0.12,
            widthNormalized: 0.3,
            heightNormalized: 0.75,
            rotationDegrees: 0 as const,
        };

        mounted.session.selection.updateCurrentManualContentBox('right', manualRight);

        await vi.waitFor(() => expect(visiblePageOneRequests().length)
            .toBeGreaterThan(previewRequestsBeforeManualCrop));
        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        expect(mounted.session.detection.pending.value).toBe(false);
        expect(mounted.session.detection.authoritativeLayoutByPage.value.get(1))
            .toBe('two-page-spread');
        expect(mounted.session.detection.pagePlanEvidenceByPage.get(1)).toBe(retainedEvidence);
        expect(mounted.session.settings.values.pageOverrides['1']?.manualContentBoxes)
            .toEqual({right: manualRight});
        expect(visiblePageOneRequests().at(-1)?.options.pageOverrides['1']?.manualContentBoxes)
            .toEqual({right: manualRight});

        await mounted.session.detection.detectAllPages();
        expect(harness.value.detectAll).toHaveBeenCalledTimes(2);
        harness.emitDetection(completedSpread('detect-2', 0.54));

        await vi.waitFor(() => expect(mounted.session.detection.pending.value).toBe(false));
        expect(mounted.session.detection.pagePlanEvidenceByPage.get(1))
            .toEqual(automaticRight(0.54));
        expect(mounted.session.settings.values.pageOverrides['1']?.manualContentBoxes)
            .toEqual({right: manualRight});
        await vi.waitFor(() => expect(visiblePageOneRequests().at(-1)
            ?.options.pageOverrides['1']?.manualContentBoxes).toEqual({right: manualRight}));
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
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(300);
            const previewCalls = vi.mocked(harness.value.preview).mock.calls.length;

            mounted.session.selection.updateCurrentPlacement('full', 'bottom-right');
            await vi.advanceTimersByTimeAsync(300);

            expect(vi.mocked(harness.value.preview).mock.calls.slice(previewCalls)).toEqual([]);
        } finally {
            vi.useRealTimers();
            mounted.unmount();
        }
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

        vi.useFakeTimers();
        try {
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
            await vi.advanceTimersByTimeAsync(300);

            expect(vi.mocked(harness.value.preview)).toHaveBeenCalledTimes(previewCallsBeforeEdit);
            expect(mounted.session.preview.result.value).toBe(cachedPageB);
        } finally {
            vi.useRealTimers();
            mounted.unmount();
        }
    });

    it('redraws the shown page when another page leaves the matched canvas', async () => {
        // Matched page size measures one rectangle over the whole document, so
        // excluding page 3 can change the sheet page 1 is presented on. The
        // page the user is looking at has to be re-rendered against it rather
        // than served from a cache measured against the document as it was.
        const harness = capabilityHarness();
        vi.mocked(harness.value.preview).mockImplementation(async request => (
            previewResult(request.pageNumber, 'single-uncut-page')
        ));
        capability.value = harness.value;
        const mounted = mountSession(`canvas-rekey-${Date.now()}`);

        await vi.waitFor(() => expect(mounted.session.preview.result.value?.pageNumber).toBe(1));
        const pageOnePreviewCalls = () => vi.mocked(harness.value.preview).mock.calls
            .filter(([request]) => request?.pageNumber === 1).length;
        const callsBeforeExclusion = pageOnePreviewCalls();

        mounted.session.selection.updatePageOverride(3, {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: true,
            manualSplit: null,
        });

        await vi.waitFor(() => expect(pageOnePreviewCalls()).toBeGreaterThan(callsBeforeExclusion));
        mounted.unmount();
    });
});
