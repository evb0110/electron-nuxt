import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {WebContents} from 'electron';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
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
    });
    return {getPdfNativeToolPaths};
});
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/scan-cleanup'}));
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
