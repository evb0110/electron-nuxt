import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;

    public readonly postMessageCalls: Array<{
        message: unknown;
        transfer: Transferable[];
    }> = [];

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();

    public constructor(
        _scriptUrl: string | URL,
        _options?: WorkerOptions,
    ) {
        FakeWorker.lastInstance = this;
    }

    public addEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            return;
        }
        this.messageHandlers.add(handler as (event: MessageEvent) => void);
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            return;
        }
        this.messageHandlers.delete(handler as (event: MessageEvent) => void);
    }

    public postMessage(message: unknown, transfer: Transferable[]) {
        this.postMessageCalls.push({
            message,
            transfer,
        });

        queueMicrotask(() => {
            const request = message as {
                id: number;
                type: string;
            };
            const data = new Uint8Array([
                9,
                8,
                7,
            ]);
            const event = {data: {
                id: request.id,
                type: request.type,
                ok: true,
                data: { data },
            }} as MessageEvent;
            this.messageHandlers.forEach((handler) => handler(event));
        });
    }

    public dispatchEvent(_event: Event) {
        return false;
    }

    public terminate() {}
}

describe('browserPdfCombineWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('posts cloned PDF buffers to the worker and returns the combined result', async () => {
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');

        const firstSource = new Uint8Array([
            0,
            1,
            2,
            3,
            4,
        ]);
        const secondSource = new Uint8Array([
            0,
            4,
            5,
            6,
            7,
        ]);
        const first = firstSource.subarray(1, 4);
        const second = secondSource.subarray(1, 4);
        const result = await runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [
            cloneCombineWorkerInput('first.pdf', first),
            cloneCombineWorkerInput('second.pdf', second),
        ]});

        expect(result.data).toEqual(new Uint8Array([
            9,
            8,
            7,
        ]));
        const worker = FakeWorker.lastInstance;
        expect(worker?.postMessageCalls).toHaveLength(1);
        const firstCall = worker?.postMessageCalls[0];
        expect(firstCall?.transfer).toHaveLength(2);
        const request = firstCall?.message as {payload: {inputs: Array<{ data: Uint8Array }>;};};
        expect(request.payload.inputs[0]?.data.buffer).not.toBe(first.buffer);
        expect(request.payload.inputs[1]?.data.buffer).not.toBe(second.buffer);
    });

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');

        await runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [cloneCombineWorkerInput('first.pdf', new Uint8Array([1]))]});
        await vi.runAllTicks();
        expect(terminateSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
    });
});
