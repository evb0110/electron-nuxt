import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

describe('ocr resource governor cancellation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '1');
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        const { ocrResourceGovernor } = await import('@electron/ocr/resourceGovernor');
        ocrResourceGovernor.reset();
    });

    it('rejects queued acquire promises removed by releaseJob', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/resourceGovernor');

        const activeLease = await ocrResourceGovernor.acquire({
            jobId: 'job-a',
            pageNumber: 1,
            requestedDpi: 300,
        });
        const queuedAcquire = ocrResourceGovernor.acquire({
            jobId: 'job-b',
            pageNumber: 1,
            requestedDpi: 300,
        });
        const rejection = expect(queuedAcquire).rejects.toThrow('OCR resource request cancelled for job job-b');

        ocrResourceGovernor.releaseJob('job-b');

        await rejection;
        ocrResourceGovernor.release(activeLease.token);
    });

    it('rejects queued acquire promises removed by reset', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/resourceGovernor');

        const activeLease = await ocrResourceGovernor.acquire({
            jobId: 'job-a',
            pageNumber: 1,
            requestedDpi: 300,
        });
        const queuedAcquire = ocrResourceGovernor.acquire({
            jobId: 'job-b',
            pageNumber: 1,
            requestedDpi: 300,
        });
        const rejection = expect(queuedAcquire).rejects.toThrow('OCR resource governor reset');

        ocrResourceGovernor.reset();

        await rejection;
        ocrResourceGovernor.release(activeLease.token);
    });
});
