import {
    describe,
    expect,
    it,
    vi,
    beforeEach,
} from 'vitest';
import { retry } from 'es-toolkit/function';
import { withTimeout } from 'es-toolkit/promise';

const mockOcr = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    createSearchablePdf: vi.fn(),
    cancel: vi.fn(),
    getLanguages: vi.fn(),
    acknowledgeResultFile: vi.fn(),
};
const mockDocuments = {
    saveDocxAs: vi.fn(),
    writeDocxFile: vi.fn(),
    readFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
};
const mockElectronAPI = {
    ocr: mockOcr,
    documents: mockDocuments, 
};

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => mockElectronAPI}));

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
});

const { useOcr } = await import('@app/composables/useOcr');

async function waitForCondition(
    condition: () => boolean,
    timeoutMs = 500,
) {
    const intervalMs = 5;
    try {
        await retry(async () => {
            if (!condition()) {
                throw new Error('Condition not met');
            }
        }, {
            retries: Math.max(0, Math.ceil(timeoutMs / intervalMs) - 1),
            delay: intervalMs,
        });
    } catch {
        throw new Error('Timed out waiting for condition');
    }
}

describe('useOcr', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockOcr.onProgress.mockReturnValue(vi.fn());
        mockOcr.onComplete.mockReturnValue(vi.fn());
        mockOcr.createSearchablePdf.mockResolvedValue({
            started: true,
            jobId: 'job-1',
        });
        mockOcr.cancel.mockResolvedValue({ canceled: true });
    });

    it('settles runOcr when canceled before completion', async () => {
        const progressUnsubscribe = vi.fn();
        const completeUnsubscribe = vi.fn();
        mockOcr.onProgress.mockReturnValue(progressUnsubscribe);
        mockOcr.onComplete.mockReturnValue(completeUnsubscribe);

        const ocr = useOcr();
        const runPromise = ocr.runOcr(
            {} as never,
            new Uint8Array([
                1,
                2,
                3,
            ]),
            1,
            1,
            '/tmp/work.pdf',
        );

        await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
        ocr.cancelOcr();

        const settled = await withTimeout(
            () => runPromise.then(() => 'resolved' as const),
            100,
        ).catch((error: unknown) => {
            if (error instanceof Error && error.name === 'TimeoutError') {
                return 'timeout' as const;
            }
            throw error;
        });

        expect(settled).toBe('resolved');
        expect(mockOcr.cancel).toHaveBeenCalledTimes(1);
        expect(progressUnsubscribe).toHaveBeenCalledTimes(1);
        expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
        expect(ocr.progress.value.isRunning).toBe(false);
        expect(ocr.error.value).toBeNull();
    });
});
