import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    class MockDjvuPdfWorkerStartupError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'DjvuPdfWorkerStartupError';
        }
    }

    return {
        StartupError: MockDjvuPdfWorkerStartupError,
        getDjvuResolution: vi.fn(),
        getDjvuPageSizeForViewing: vi.fn(),
        cancelConversion: vi.fn(),
        convertDjvuPageToImage: vi.fn(),
        createDjvuPdfEstimateTask: vi.fn(),
        buildOptimizedPdf: vi.fn(),
        te: vi.fn((key: string) => key),
        mkdtemp: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        randomUUID: vi.fn(),
        loggerWarn: vi.fn(),
        loggerDebug: vi.fn(),
    };
});

vi.mock('electron', () => ({app: {getPath: vi.fn(() => '/tmp')}}));

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    rm: mocks.rm,
    stat: mocks.stat,
}));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({
    cancelConversion: mocks.cancelConversion,
    convertDjvuPageToImage: mocks.convertDjvuPageToImage,
}));

vi.mock('@electron/features/djvu/main/pdfWorkerClient', () => ({
    createDjvuPdfEstimateTask: mocks.createDjvuPdfEstimateTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));

vi.mock('@electron/djvu/metadata', () => ({getDjvuResolution: mocks.getDjvuResolution}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({getDjvuPageSizeForViewing: mocks.getDjvuPageSizeForViewing}));
vi.mock('@electron/djvu/buildOptimizedPdf', () => ({buildOptimizedPdf: mocks.buildOptimizedPdf}));
vi.mock('@electron/te', () => ({te: mocks.te}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
    info: vi.fn(),
    error: vi.fn(),
})}));

const { estimateSizes } = await import('@electron/djvu/estimateSizes');

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        reject,
        resolve,
    };
}

describe('estimateSizes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDjvuResolution.mockResolvedValue(400);
        mocks.getDjvuPageSizeForViewing.mockResolvedValue({
            width: 2_400,
            height: 3_200,
            dpi: 400,
        });
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-estimate-test');
        mocks.rm.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1_024,
        });
        mocks.randomUUID.mockReturnValue('estimate-job');
        mocks.convertDjvuPageToImage.mockResolvedValue({success: true});
        mocks.buildOptimizedPdf.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
            4,
        ]));
        mocks.createDjvuPdfEstimateTask.mockImplementation((_imagePath: string, _dpi: number) => ({
            worker: { terminate: vi.fn(() => Promise.resolve(0)) },
            promise: Promise.resolve(123),
        }));
    });

    it('uses the worker estimate result when the worker is available', async () => {
        const estimates = await estimateSizes('/tmp/worker-success.djvu', 10);

        expect(estimates).toHaveLength(3);
        expect(estimates.map(entry => entry.estimatedBytes)).toEqual([
            1230,
            1230,
            1230,
        ]);
        expect(mocks.createDjvuPdfEstimateTask).toHaveBeenCalledTimes(3);
        expect(mocks.buildOptimizedPdf).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
        expect(mocks.convertDjvuPageToImage).toHaveBeenNthCalledWith(
            1,
            '/tmp/worker-success.djvu',
            '/tmp/djvu-estimate-test/sample-s1.ppm',
            3,
            'estimate-estimate-job-1',
            expect.objectContaining({
                targetHeightPx: 3_200,
                targetWidthPx: 2_400,
            }),
        );
    });

    it('caps a large full-quality estimate sample before native rendering', async () => {
        mocks.getDjvuPageSizeForViewing.mockResolvedValue({
            width: 20_000,
            height: 20_000,
            dpi: 400,
        });

        await estimateSizes('/tmp/large-estimate.djvu', 10);

        const firstOptions = mocks.convertDjvuPageToImage.mock.calls[0]?.[4];
        expect(firstOptions.targetWidthPx * firstOptions.targetHeightPx).toBeLessThanOrEqual(12_000_000);
        expect(firstOptions).not.toHaveProperty('subsample');
    });

    it('falls back to in-process PDF building when worker startup fails', async () => {
        mocks.createDjvuPdfEstimateTask.mockImplementation(() => {
            throw new mocks.StartupError('worker missing');
        });

        const estimates = await estimateSizes('/tmp/startup-fallback.djvu', 10);

        expect(estimates).toHaveLength(3);
        expect(estimates.map(entry => entry.estimatedBytes)).toEqual([
            40,
            40,
            40,
        ]);
        expect(mocks.buildOptimizedPdf).toHaveBeenCalledTimes(3);
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(3);
    });

    it('keeps a coalesced estimate running when one waiter aborts', async () => {
        const firstImageConversion = createDeferred<{ success: true }>();
        let imageConversionCount = 0;
        mocks.convertDjvuPageToImage.mockImplementation(() => {
            imageConversionCount += 1;
            return imageConversionCount === 1
                ? firstImageConversion.promise
                : Promise.resolve({success: true});
        });
        const firstController = new AbortController();
        const secondController = new AbortController();

        const firstEstimate = estimateSizes('/tmp/coalesced-waiters.djvu', 10, {signal: firstController.signal});
        const secondEstimate = estimateSizes('/tmp/coalesced-waiters.djvu', 10, {signal: secondController.signal});

        await vi.waitFor(() => expect(mocks.convertDjvuPageToImage).toHaveBeenCalledTimes(1));

        const firstRejection = expect(firstEstimate).rejects.toThrow('first waiter canceled');
        firstController.abort(new Error('first waiter canceled'));
        await firstRejection;
        expect(mocks.cancelConversion).not.toHaveBeenCalled();

        firstImageConversion.resolve({success: true});
        await expect(secondEstimate).resolves.toHaveLength(3);
        expect(mocks.getDjvuResolution).toHaveBeenCalledTimes(1);
        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledTimes(3);
        expect(mocks.createDjvuPdfEstimateTask).toHaveBeenCalledTimes(3);
    });
});
