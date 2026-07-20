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
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {useScanCleanupWorkspaceSession} from '@app/modules/scan-cleanup/composables/useScanCleanupWorkspaceSession';
import {saveScanCleanupPreferences} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

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
            cutterX: null,
        }));
    return {
        jobId,
        status,
        progress: {
            detectedCount: results.length,
            totalPages,
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
            started: true,
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
        localStorage.clear();
    });

    afterEach(() => {
        capability.value = null;
    });

    it('auto-detects on open and does not auto-restart a document after user cancellation', async () => {
        const harness = capabilityHarness();
        capability.value = harness.value;
        const documentKey = `cancel-${Date.now()}`;
        const first = mountSession(documentKey);

        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledOnce());
        expect(first.session.detectionPending.value).toBe(true);
        await first.session.cancelDetection();
        harness.emitDetection(detectionState('detect-1', 'canceled'));
        first.unmount();

        const reopened = mountSession(documentKey);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(harness.value.detectAll).toHaveBeenCalledOnce();
        expect(reopened.session.detectionPending.value).toBe(false);
        reopened.unmount();
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

        saveScanCleanupPreferences({
            firstRunGuidanceDismissed: false,
            layoutMode: 'force-single',
            outputMode: 'bw',
            readingOrder: 'ltr',
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'top-center',
            marginsMm: 5,
            despeckle: true,
            skipBlankPages: false,
            straightenCurvedLines: false,
            runOcrAfterCleanup: false,
        });
        const stale = mountSession(documentKey);
        await vi.waitFor(() => expect(harness.value.detectAll).toHaveBeenCalledTimes(2));
        stale.unmount();
    });
});
