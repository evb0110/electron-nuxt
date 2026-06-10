import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    availableParallelism: vi.fn(() => 8),
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('os', () => ({
    availableParallelism: mocks.availableParallelism,
    totalmem: mocks.totalmem,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('ocr resource governor', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.availableParallelism.mockReturnValue(8);
        mocks.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');
        ocrResourceGovernor.reset();
    });

    it('rejects queued acquire promises removed by releaseJob', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '1');
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
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '1');
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

    it('keeps normal requests queued while a high-DPI request is active', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        const highDpiLease = await ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
        });
        const normalAcquire = ocrResourceGovernor.acquire({
            jobId: 'job-normal',
            pageNumber: 1,
            requestedDpi: 300,
        });
        let wasGranted = false;
        void normalAcquire.then(() => {
            wasGranted = true;
        });

        await flushMicrotasks();

        expect(wasGranted).toBe(false);

        ocrResourceGovernor.release(highDpiLease.token);
        const normalLease = await normalAcquire;

        expect(normalLease.effectiveDpi).toBe(300);
        ocrResourceGovernor.release(normalLease.token);
    });

    it('expands queued normal requests to the normal slot count after a high-DPI request releases', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        const highDpiLease = await ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
        });
        const queuedNormalAcquires = [
            ocrResourceGovernor.acquire({
                jobId: 'job-normal-1',
                pageNumber: 1,
                requestedDpi: 300,
            }),
            ocrResourceGovernor.acquire({
                jobId: 'job-normal-2',
                pageNumber: 1,
                requestedDpi: 300,
            }),
            ocrResourceGovernor.acquire({
                jobId: 'job-normal-3',
                pageNumber: 1,
                requestedDpi: 300,
            }),
        ];
        const grantedTokens: string[] = [];
        queuedNormalAcquires.forEach((acquire) => {
            void acquire.then((lease) => {
                grantedTokens.push(lease.token);
            });
        });

        await flushMicrotasks();

        expect(grantedTokens).toHaveLength(0);

        ocrResourceGovernor.release(highDpiLease.token);
        const normalLeases = await Promise.all(queuedNormalAcquires);

        expect(normalLeases).toHaveLength(3);
        expect(normalLeases.map(lease => lease.effectiveDpi)).toEqual([
            300,
            300,
            300,
        ]);
        normalLeases.forEach(lease => ocrResourceGovernor.release(lease.token));
    });

    it('uses configured slot limits above the normal default when dispatching from no active leases', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        const highDpiLease = await ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
        });
        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '4');

        const queuedNormalAcquires = Array.from({ length: 4 }, (_value, index) => ocrResourceGovernor.acquire({
            jobId: `job-normal-${index + 1}`,
            pageNumber: 1,
            requestedDpi: 300,
        }));
        const grantedTokens: string[] = [];
        queuedNormalAcquires.forEach((acquire) => {
            void acquire.then((lease) => {
                grantedTokens.push(lease.token);
            });
        });

        await flushMicrotasks();

        expect(grantedTokens).toHaveLength(0);

        ocrResourceGovernor.release(highDpiLease.token);
        const normalLeases = await Promise.all(queuedNormalAcquires);

        expect(normalLeases).toHaveLength(4);
        expect(normalLeases.map(lease => lease.effectiveDpi)).toEqual([
            300,
            300,
            300,
            300,
        ]);
        normalLeases.forEach(lease => ocrResourceGovernor.release(lease.token));
    });

    it('does not grant later normal requests ahead of a queued high-DPI request', async () => {
        const { ocrResourceGovernor } = await import('@electron/ocr/ocrResourceGovernor');

        const activeNormalLease = await ocrResourceGovernor.acquire({
            jobId: 'job-active-normal',
            pageNumber: 1,
            requestedDpi: 300,
        });
        const highDpiAcquire = ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
        });
        const laterNormalAcquire = ocrResourceGovernor.acquire({
            jobId: 'job-later-normal',
            pageNumber: 1,
            requestedDpi: 300,
        });
        let laterNormalLease: Awaited<typeof laterNormalAcquire> | null = null;
        void laterNormalAcquire.then((lease) => {
            laterNormalLease = lease;
        });

        await flushMicrotasks();

        expect(laterNormalLease).toBeNull();

        ocrResourceGovernor.release(activeNormalLease.token);
        const highDpiLease = await highDpiAcquire;

        expect(highDpiLease.effectiveDpi).toBe(600);
        expect(laterNormalLease).toBeNull();

        ocrResourceGovernor.release(highDpiLease.token);
        const grantedLaterNormalLease = await laterNormalAcquire;

        expect(grantedLaterNormalLease.effectiveDpi).toBe(300);
        ocrResourceGovernor.release(grantedLaterNormalLease.token);
    });
});
