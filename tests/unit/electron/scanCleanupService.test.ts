import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {WebContents} from 'electron';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';

const mocks = vi.hoisted(() => {
    const runWorker = vi.fn(async () => ({
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
    return {runWorker};
});

vi.mock('@electron/features/scan-cleanup/runScanCleanupWorkerTask', () => (
    {runScanCleanupWorkerTask: mocks.runWorker}
));
vi.mock('@electron/resources/jobBroker', () => {
    const acquire = vi.fn(async () => ({release: vi.fn()}));
    return {mainJobBroker: {acquire}};
});
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
vi.mock('@electron/features/scan-cleanup/scanCleanupGeneratedOutputs', () => {
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

const owner = {
    ownerId: 'cleanup-owner',
    documentRevision: 'revision-1',
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
    it('treats cancellation of an already-terminal owned job as a successful no-op', async () => {
        const service = createScanCleanupService();
        const webContents = sender();
        const started = await service.start(webContents, {
            ...owner,
            sourcePdfPath: '/source.pdf',
            sourcePageNumbers: [3],
            options: {
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'color',
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
            },
        });
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
