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
        convertDjvuPageToImage: vi.fn(),
        createDjvuPdfEstimateTask: vi.fn(),
        buildOptimizedPdf: vi.fn(),
        te: vi.fn((key: string) => key),
        mkdtemp: vi.fn(),
        rm: vi.fn(),
        randomUUID: vi.fn(),
        loggerWarn: vi.fn(),
        loggerDebug: vi.fn(),
    };
});

vi.mock('electron', () => ({app: {getPath: vi.fn(() => '/tmp')}}));

vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    rm: mocks.rm,
}));

vi.mock('node:crypto', () => ({randomUUID: mocks.randomUUID}));

vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({convertDjvuPageToImage: mocks.convertDjvuPageToImage}));

vi.mock('@electron/features/djvu/main/pdfWorkerClient', () => ({
    createDjvuPdfEstimateTask: mocks.createDjvuPdfEstimateTask,
    DjvuPdfWorkerStartupError: mocks.StartupError,
}));

vi.mock('@electron/djvu/metadata', () => ({getDjvuResolution: mocks.getDjvuResolution}));
vi.mock('@electron/djvu/pdfBuilder', () => ({buildOptimizedPdf: mocks.buildOptimizedPdf}));
vi.mock('@electron/i18n', () => ({te: mocks.te}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
    info: vi.fn(),
    error: vi.fn(),
})}));

const { estimateSizes } = await import('@electron/djvu/estimate');

describe('estimateSizes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDjvuResolution.mockResolvedValue(400);
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-estimate-test');
        mocks.rm.mockResolvedValue(undefined);
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
});
