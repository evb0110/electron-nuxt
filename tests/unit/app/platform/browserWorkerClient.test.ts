import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserWorkerClient } from '@app/platform/browser-api/browserWorkerClient';

interface IPendingTestRequest {
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

class FakeWorker extends EventTarget {
    public static terminateCount = 0;

    public terminate() {
        FakeWorker.terminateCount += 1;
    }
}

function createWorkerClient() {
    return new BrowserWorkerClient<IPendingTestRequest>({
        idleTtlMs: 15_000,
        requestTimeoutMs: 1_000,
        createWorker: () => new FakeWorker() as Worker,
        createError: event => new Error(event.message),
        handleMessage: () => {},
    });
}

describe('BrowserWorkerClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeWorker.terminateCount = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects only the timed-out request while sibling requests stay pending', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const firstReject = vi.fn();
        const secondReject = vi.fn();

        client.registerPendingRequest(1, { reject: firstReject }, () => new Error('first timed out'));
        await vi.advanceTimersByTimeAsync(500);
        client.registerPendingRequest(2, { reject: secondReject }, () => new Error('second timed out'));

        await vi.advanceTimersByTimeAsync(500);

        expect(firstReject).toHaveBeenCalledOnce();
        expect(firstReject.mock.calls[0]?.[0].message).toBe('first timed out');
        expect(secondReject).not.toHaveBeenCalled();
        expect(client.hasPendingRequest(2)).toBe(true);
        expect(FakeWorker.terminateCount).toBe(0);

        client.cancelPendingRequest(2, new Error('cleanup'));
    });

    it('terminates an idle worker immediately after the last pending request times out', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const reject = vi.fn();

        client.registerPendingRequest(1, { reject }, () => new Error('request timed out'));

        await vi.advanceTimersByTimeAsync(1_000);

        expect(reject).toHaveBeenCalledOnce();
        expect(client.hasWorker()).toBe(false);
        expect(FakeWorker.terminateCount).toBe(1);
    });

    it('supports a longer timeout for an individual large request', async () => {
        const client = createWorkerClient();
        client.getWorker();
        const reject = vi.fn();

        client.registerPendingRequest(
            1,
            { reject },
            () => new Error('large request timed out'),
            2_000,
        );

        await vi.advanceTimersByTimeAsync(1_000);
        expect(reject).not.toHaveBeenCalled();
        expect(client.hasPendingRequest(1)).toBe(true);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(reject).toHaveBeenCalledOnce();
    });
});
