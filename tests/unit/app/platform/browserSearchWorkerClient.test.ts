import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;

    public readonly postMessageCalls: unknown[] = [];

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();

    private readonly errorHandlers = new Set<(event: ErrorEvent) => void>();

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
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.add(handler as (event: MessageEvent) => void);
        }
        if (type === 'error') {
            this.errorHandlers.add(handler);
        }
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.delete(handler as (event: MessageEvent) => void);
        }
        if (type === 'error') {
            this.errorHandlers.delete(handler);
        }
    }

    public postMessage(message: unknown) {
        this.postMessageCalls.push(message);
        const request = message as {
            id: number;
            type: string;
            payload: Record<string, unknown>;
        };

        queueMicrotask(() => {
            if (request.type === 'cancel') {
                this.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: { canceled: true },
                });
                return;
            }

            this.dispatchMessage({
                id: request.id,
                type: request.type,
                ok: true,
                progress: {
                    processed: 1,
                    total: 2,
                },
            });
            this.dispatchMessage({
                id: request.id,
                type: request.type,
                ok: true,
                data: {
                    pageCount: 2,
                    pageTexts: [
                        'alpha',
                        'beta',
                    ],
                },
            });
        });
    }

    private dispatchMessage(data: unknown) {
        const event = { data } as MessageEvent;
        this.messageHandlers.forEach((handler) => handler(event));
    }

    public dispatchEvent(_event: Event) {
        return false;
    }

    public terminate() {}
}

describe('browserSearchWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('returns extracted page text and forwards progress updates', async () => {
        const onProgress = vi.fn();
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/test.pdf' },
            { onProgress },
        );
        const result = await workerRequest.promise;

        expect(workerRequest.requestId).toBeGreaterThan(0);
        expect(result).toEqual({
            pageCount: 2,
            pageTexts: [
                'alpha',
                'beta',
            ],
        });
        expect(onProgress).toHaveBeenCalledWith({
            processed: 1,
            total: 2,
        });
    });

    it('rejects active jobs and resets the worker on cancel', async () => {
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browserSearchWorkerClient');

        const workerRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/pending.pdf' },
        );
        await cancelBrowserSearchWorkerRequest(workerRequest.requestId);
        await expect(workerRequest.promise).rejects.toThrow('ERR_BROWSER_SEARCH_CANCELED');

        const postMessages = FakeWorker.lastInstance?.postMessageCalls ?? [];
        expect(postMessages).toHaveLength(1);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browserSearchWorkerClient');

        await runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/test.pdf'});
        await vi.runAllTicks();
        const terminateCallsBeforeIdleTtl = terminateSpy.mock.calls.length;

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(terminateCallsBeforeIdleTtl + 1);
    });
});
