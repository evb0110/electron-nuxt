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
            this.errorHandlers.add(handler as (event: ErrorEvent) => void);
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
            this.errorHandlers.delete(handler as (event: ErrorEvent) => void);
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

    public dispatchEvent(_event: Event): boolean {
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
        const {createBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browser-search-worker-client');

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

    it('posts cancel requests for active worker jobs', async () => {
        const {
            createBrowserSearchWorkerRequest,
            cancelBrowserSearchWorkerRequest,
        } = await import('@app/platform/browser-api/browser-search-worker-client');

        const workerRequest = createBrowserSearchWorkerRequest(
            'extractDocumentText',
            { pdfPath: '/tmp/pending.pdf' },
        );
        await cancelBrowserSearchWorkerRequest(workerRequest.requestId);
        await workerRequest.promise;

        const postMessages = FakeWorker.lastInstance?.postMessageCalls ?? [];
        expect(postMessages).toHaveLength(2);
        expect(postMessages[1]).toEqual(expect.objectContaining({
            type: 'cancel',
            payload: { requestId: workerRequest.requestId },
        }));
    });

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {runBrowserSearchWorkerRequest} = await import('@app/platform/browser-api/browser-search-worker-client');

        await runBrowserSearchWorkerRequest('extractDocumentText', {pdfPath: '/tmp/test.pdf'});
        await vi.runAllTicks();
        expect(terminateSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
    });
});
