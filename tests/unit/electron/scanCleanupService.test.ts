import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {WebContents} from 'electron';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import type * as TPageOpsModule from '@electron/features/page-ops/public';
import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import {decodeScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    JobBroker,
    type IJobBrokerRequest,
    resolveMainJobBrokerCapacity,
} from '@electron/resources/jobBroker';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';

const mocks = vi.hoisted(() => {
    const acquire = vi.fn(async (_request: IJobBrokerRequest) => ({release: vi.fn()}));
    const runWorker = vi.fn(async (
        _request: unknown,
        _paths: unknown,
        _runtimePolicy: unknown,
        _signal: unknown,
        _onProgress: unknown,
    ) => ({
        inputPages: 1,
        outputPages: 1,
        spreadsSplit: 0,
        offcutsDiscarded: 0,
        deskewSkipped: 0,
        cropSkipped: 0,
        excludedPages: 0,
        blankPagesSkipped: 0,
        warnings: [],
    }));
    const host = {
        logicalCpus: 11,
        totalRamBytes: 32 * 1024 ** 3,
        tier: 'high' as 'low' | 'medium' | 'high',
    };
    return {
        acquire,
        host,
        hostProfile: () => host as IHostResourceProfileSnapshot,
        pageOpsDisabled: false,
        runWorker,
    };
});

vi.mock('@electron/features/scan-cleanup/runScanCleanupWorkerTask', () => (
    {runScanCleanupWorkerTask: mocks.runWorker}
));
vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {
            acquire: mocks.acquire,
            getSnapshot: () => ({capacity: actual.resolveMainJobBrokerCapacity(mocks.hostProfile())}),
        },
    };
});
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: mocks.hostProfile}));
vi.mock('@electron/pdf/nativeToolPaths', () => {
    const getPdfNativeToolPaths = () => ({
        qpdf: '/qpdf',
        pdftoppm: '/pdftoppm',
        pdfinfo: '/pdfinfo',
    });
    return {getPdfNativeToolPaths};
});
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/scan-cleanup'}));
vi.mock('@electron/features/page-ops/public', async importOriginal => ({
    ...await importOriginal<typeof TPageOpsModule>(),
    isNativePageOpsDisabled: () => mocks.pageOpsDisabled,
    resolveNativePageOpsPath: () => '/page-ops',
}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => (
    {resolveNativePdfImageCombinePath: () => '/pdf-image-combine'}
));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => {
    const createScanCleanupGeneratedOutputPath = async () => '/managed/cleaned.pdf';
    const pruneScanCleanupGeneratedOutputs = async () => 0;
    return {
        createScanCleanupGeneratedOutputPath,
        pruneScanCleanupGeneratedOutputs,
    };
});
vi.mock('@electron/output/documentOutputService', () => ({documentOutputService: {
    start: vi.fn(),
    update: vi.fn(),
    handoff: vi.fn(),
    finish: vi.fn(),
}}));
vi.mock('@electron/file-access/workingCopyStore', () => ({getWorkingCopyBackingEntry: () => ({backing: 'materialized'})}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: async (sourcePdfPath: string) => ({physicalWorkingCopyPath: sourcePdfPath})}));

const owner = {
    ownerId: 'cleanup-owner',
    documentRevision: 'revision-1',
};
const startRequest = {
    ...owner,
    sourcePdfPath: '/source.pdf',
    sourcePageNumbers: [3],
    layoutByPage: {'3': 'two-page-spread' as const},
    options: {
        preserveOriginalQuality: false,
        layoutMode: 'auto' as const,
        outputMode: 'color' as const,
        readingOrder: 'ltr' as const,
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center' as const,
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckle: true,
        skipBlankPages: false,
        pageOverrides: {},
    },
};

function sender(): WebContents {
    return {
        id: 42,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } as never;
}

describe('scan cleanup service', () => {
    beforeEach(() => {
        mocks.acquire.mockClear();
        mocks.runWorker.mockClear();
        mocks.pageOpsDisabled = false;
        Object.assign(mocks.host, {
            logicalCpus: 11,
            totalRamBytes: 32 * 1024 ** 3,
            tier: 'high',
        });
    });

    it.each([
        [
            '4-core / 8 GiB',
            4,
            8,
            'low',
            1,
        ],
        [
            '6-core / 12 GiB',
            6,
            12,
            'medium',
            2,
        ],
        [
            '11-core / 32 GiB',
            11,
            32,
            'high',
            4,
        ],
        [
            '32-core / 128 GiB',
            32,
            128,
            'high',
            7,
        ],
    ] as const)('fans raster work out to the %s host and leases exactly what it fans out', async (
        _label,
        logicalCpus,
        totalRamGiB,
        tier,
        rasterConcurrency,
    ) => {
        Object.assign(mocks.host, {
            logicalCpus,
            totalRamBytes: totalRamGiB * 1024 ** 3,
            tier,
        });
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(decodeScanCleanupRuntimePolicy(mocks.runWorker.mock.calls[0]![2])).toEqual({
            rasterConcurrency,
            logicalCpus,
            totalRamBytes: totalRamGiB * 1024 ** 3,
        });

        const leased = mocks.acquire.mock.calls[0]![0].resources;
        expect(leased).toMatchObject({
            cpuTokens: rasterConcurrency,
            nativeProcesses: rasterConcurrency,
        });
        expect(leased.estimatedResidentBytes / rasterConcurrency).toBeGreaterThanOrEqual(64 * 1024 * 1024);
        await expect(new JobBroker(resolveMainJobBrokerCapacity(mocks.hostProfile())).acquire({
            ownerId: 'admission-probe',
            kind: 'scan-cleanup',
            priority: 'user',
            resources: leased,
        })).resolves.toBeDefined();
    });

    it('gives a default raster run the page-ops tool its matched canvas is measured with', async () => {
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        // The default run is a raster run with matching on. Resolving page-ops
        // only for lossless runs is how matching used to be dropped without
        // telling anyone.
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({options: {
            preserveOriginalQuality: false,
            matchPageSize: true,
        }});
        expect(mocks.runWorker.mock.calls[0]![1]).toMatchObject({pdfPageOpsBinary: '/page-ops'});
        // And the layouts the preview measured its canvas from reach the run, so
        // the run measures the same rectangle.
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({layoutByPage: {'3': 'two-page-spread'}});
    });

    it('leaves page-ops out of a run that needs no page geometry', async () => {
        const service = createScanCleanupService();
        await service.start(sender(), {
            ...startRequest,
            options: {
                ...startRequest.options,
                matchPageSize: false,
            },
        });

        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(mocks.runWorker.mock.calls[0]![1]).not.toHaveProperty('pdfPageOpsBinary');
    });

    it('keeps a matched raster run going on Poppler geometry when page-ops is disabled', async () => {
        mocks.pageOpsDisabled = true;
        const service = createScanCleanupService();
        await service.start(sender(), startRequest);

        // Matching is a default setting and the geometry it needs is something
        // Poppler reports too, so disabling page-ops does not take the feature
        // away — the worker is handed pdfinfo instead.
        await vi.waitFor(() => expect(mocks.runWorker).toHaveBeenCalledOnce());
        expect(mocks.runWorker.mock.calls[0]![1]).not.toHaveProperty('pdfPageOpsBinary');
        expect(mocks.runWorker.mock.calls[0]![1]).toMatchObject({pdfinfoBinary: expect.any(String)});
        expect(mocks.runWorker.mock.calls[0]![0]).toMatchObject({options: {matchPageSize: true}});
    });

    it('names the tool a lossless run cannot start without', async () => {
        mocks.pageOpsDisabled = true;
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, {
            ...startRequest,
            options: {
                ...startRequest.options,
                preserveOriginalQuality: true,
            },
        });
        if (!started.started) throw new Error('Expected scan cleanup to start');

        // The lossless path assembles with evb-pdf-page-ops itself, so there is
        // nothing to fall back to and the run says which tool is missing.
        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({
                status: 'failed',
                errorCode: 'internal',
            }));
        const terminal = service.getState(webContents, started.jobId, owner);
        expect(terminal?.status === 'failed' ? terminal.error : '').toContain('evb-pdf-page-ops');
        expect(mocks.runWorker).not.toHaveBeenCalled();
    });

    it('treats cancellation of an already-terminal owned job as a successful no-op', async () => {
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, startRequest);
        expect(started.started).toBe(true);
        if (!started.started) throw new Error('Expected scan cleanup to start');

        await vi.waitFor(() => expect(service.getState(webContents, started.jobId, owner))
            .toMatchObject({
                status: 'completed',
                partial: true,
                progress: {
                    completedPageNumbers: [3],
                    totalUnits: 1,
                },
            }));
        expect(service.cancel(webContents, started.jobId, owner)).toBe(true);
        expect(service.getState(webContents, started.jobId, owner)?.status).toBe('completed');
    });
});
