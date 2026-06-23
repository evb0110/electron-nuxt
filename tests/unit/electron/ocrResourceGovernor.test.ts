import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ocrResourceGovernor as importedOcrResourceGovernor } from '@electron/ocr/ocrResourceGovernor';

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

type TOcrResourceGovernor = typeof importedOcrResourceGovernor;

async function loadOcrResourceGovernor(): Promise<TOcrResourceGovernor> {
    return (await import('@electron/ocr/ocrResourceGovernor')).ocrResourceGovernor;
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
        const ocrResourceGovernor = await loadOcrResourceGovernor();
        ocrResourceGovernor.reset();
    });

    it('rejects queued acquire promises removed by releaseJob', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

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
        const ocrResourceGovernor = await loadOcrResourceGovernor();

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

    it('grants normal requests while a high-DPI request is active when weighted slots remain', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

        const highDpiLease = await ocrResourceGovernor.acquire({
            jobId: 'job-high',
            pageNumber: 1,
            requestedDpi: 600,
        });
        const normalLease = await ocrResourceGovernor.acquire({
            jobId: 'job-normal',
            pageNumber: 1,
            requestedDpi: 300,
        });

        expect(normalLease.effectiveDpi).toBe(300);
        ocrResourceGovernor.release(highDpiLease.token);
        ocrResourceGovernor.release(normalLease.token);
    });

    it('caps huge-page effective DPI below the legacy floor to honor the rendered-pixel budget', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

        const lease = await ocrResourceGovernor.acquire({
            jobId: 'job-huge-page',
            pageNumber: 1,
            requestedDpi: 300,
            pageWidthIn: 500,
            pageHeightIn: 500,
        });
        const renderedPixels = Math.ceil(500 * lease.effectiveDpi) * Math.ceil(500 * lease.effectiveDpi);

        expect(lease.effectiveDpi).toBeLessThan(150);
        expect(renderedPixels).toBeLessThanOrEqual(45_000_000);

        ocrResourceGovernor.release(lease.token);
    });

    it('uses remaining weighted slots while a high-DPI request is active and drains the rest after release', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

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
            ocrResourceGovernor.acquire({
                jobId: 'job-normal-4',
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

        expect(grantedTokens).toHaveLength(2);

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

    it('uses configured slot limits above the normal default when dispatching from no active leases', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

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

        expect(grantedTokens).toHaveLength(2);

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

    it('skips a blocked high-DPI request to grant a later normal request that fits remaining slots', async () => {
        const ocrResourceGovernor = await loadOcrResourceGovernor();

        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '2');
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
        const laterNormalLease = await laterNormalAcquire;

        expect(laterNormalLease).toEqual(expect.objectContaining({effectiveDpi: 300}));
        ocrResourceGovernor.release(laterNormalLease.token);
        ocrResourceGovernor.release(activeNormalLease.token);
        const highDpiLease = await highDpiAcquire;

        expect(highDpiLease.effectiveDpi).toBe(600);
        ocrResourceGovernor.release(highDpiLease.token);
    });
});
