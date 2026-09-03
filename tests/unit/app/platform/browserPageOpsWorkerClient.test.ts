import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
    occurredAt: 1,
    severity: 'error',
};
let reporterAvailable = true;
const failureReporter = {capture: vi.fn(() => failureReceipt)};
const fallbackReporter = vi.fn(() => failureReporter);

vi.mock('@app/utils/failureReporter', () => ({
    detectRendererDiagnosticsHost: () => 'hosted-browser',
    getRendererFailureReporter: () => reporterAvailable ? failureReporter : null,
    initializeRendererFailureReporter: fallbackReporter,
}));

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();
    private readonly errorHandlers = new Set<(event: ErrorEvent) => void>();

    public constructor() {
        FakeWorker.lastInstance = this;
    }

    public addEventListener(type: string, handler: EventListenerOrEventListenerObject | null) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.add(handler as (event: MessageEvent) => void);
        } else if (type === 'error') {
            this.errorHandlers.add(handler as (event: ErrorEvent) => void);
        }
    }

    public removeEventListener(type: string, handler: EventListenerOrEventListenerObject | null) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.delete(handler as (event: MessageEvent) => void);
        } else if (type === 'error') {
            this.errorHandlers.delete(handler as (event: ErrorEvent) => void);
        }
    }

    public postMessage(message: {
        id: number;
        type: string
    }) {
        queueMicrotask(() => this.dispatchMessage({
            id: message.id,
            type: message.type,
            ok: true,
            data: {
                data: new Uint8Array([2]),
                pageCount: 1,
            },
        }));
    }

    public dispatchMessage(data: unknown) {
        const event = {data} as MessageEvent;
        this.messageHandlers.forEach((handler) => handler(event));
    }

    public dispatchError(error: Error) {
        const event = {
            error,
            message: error.message,
        } as ErrorEvent;
        this.errorHandlers.forEach((handler) => handler(event));
    }

    public terminate() {}
}

describe('browserPageOpsWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        FakeWorker.lastInstance = null;
        failureReporter.capture.mockClear();
        fallbackReporter.mockClear();
        reporterAvailable = true;
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const request = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser page operations worker');
        }

        worker.dispatchError(new Error('page operations worker crashed'));
        const error = await request.then(
            () => { throw new Error('Expected a worker failure'); },
            value => {
                if (!(value instanceof Error)) {
                    throw new Error('Expected a worker failure');
                }
                return value as Error & {failure?: unknown};
            },
        );

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledWith(
            expect.objectContaining({local: expect.objectContaining({source: 'browser-page-ops-worker-parent'})}),
            {runtime: 'browser-worker-parent'},
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('does not report an idle worker termination', async () => {
        vi.useFakeTimers();
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const result = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        await result;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledOnce();
        expect(failureReporter.capture).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('uses a fallback reporter when the shared reporter is unavailable', async () => {
        reporterAvailable = false;
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const request = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser page operations worker');
        }

        worker.dispatchError(new Error('page operations worker crashed'));
        await request.catch(() => undefined);

        expect(fallbackReporter).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledOnce();
    });
});
