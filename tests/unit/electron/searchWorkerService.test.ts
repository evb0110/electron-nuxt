import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { SearchWorkerService } from '@electron/features/search/main/searchWorkerService';

const workerMocks = vi.hoisted(() => ({instances: [] as Array<{
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    emit: (event: string, payload: unknown) => void;
}>}));

const electronMocks = vi.hoisted(() => ({send: vi.fn()}));

vi.mock('electron', () => ({webContents: {fromId: vi.fn(() => ({
    isDestroyed: () => false,
    send: electronMocks.send,
}))}}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

vi.mock('worker_threads', () => {
    class MockWorker {
        private readonly onHandlers = new Map<string, Array<(payload: unknown) => void>>();
        private readonly onceHandlers = new Map<string, Array<(payload: unknown) => void>>();

        postMessage = vi.fn();
        terminate = vi.fn(async () => undefined);

        constructor() {
            workerMocks.instances.push({
                postMessage: this.postMessage,
                terminate: this.terminate,
                emit: (event: string, payload: unknown) => {
                    this.emit(event, payload);
                },
            });
        }

        on(event: string, handler: (payload: unknown) => void) {
            const handlers = this.onHandlers.get(event) ?? [];
            handlers.push(handler);
            this.onHandlers.set(event, handlers);
            return this;
        }

        once(event: string, handler: (payload: unknown) => void) {
            const handlers = this.onceHandlers.get(event) ?? [];
            handlers.push(handler);
            this.onceHandlers.set(event, handlers);
            return this;
        }

        removeListener(event: string, handler: (payload: unknown) => void) {
            this.onHandlers.set(event, (this.onHandlers.get(event) ?? []).filter(item => item !== handler));
            this.onceHandlers.set(event, (this.onceHandlers.get(event) ?? []).filter(item => item !== handler));
            return this;
        }

        private emit(event: string, payload: unknown) {
            for (const handler of this.onHandlers.get(event) ?? []) {
                handler(payload);
            }
            const onceHandlers = this.onceHandlers.get(event) ?? [];
            this.onceHandlers.delete(event);
            for (const handler of onceHandlers) {
                handler(payload);
            }
        }
    }

    return { Worker: MockWorker };
});

function createSender(id: number): Electron.WebContents {
    const sender: Partial<Electron.WebContents> = {
        id,
        isDestroyed: () => false,
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    };
    return sender as Electron.WebContents;
}

function emitWorkerComplete(workerIndex: number, requestId: string) {
    workerMocks.instances[workerIndex]?.emit('message', {
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function emitWorkerCancelled(workerIndex: number, requestId: string) {
    workerMocks.instances[workerIndex]?.emit('message', {
        type: 'cancelled',
        requestId,
    });
}

function dispatchSearch(
    service: SearchWorkerService,
    sender: Electron.WebContents,
    requestId: string,
    options: {
        pdfPath?: string;
        senderId?: number;
        warmup?: boolean;
    } = {},
) {
    return service.dispatchSearchRequest(
        {
            sender,
            senderId: options.senderId ?? sender.id,
        },
        {
            resolvedPdfPath: options.pdfPath ?? '/tmp/work.pdf',
            documentRevision: 'revision-token',
            query: options.warmup ? '' : 'term',
            requestId,
            requestIdPrefix: 'search',
            ...(options.warmup === undefined ? {} : {warmup: options.warmup}),
        },
    );
}

describe('SearchWorkerService', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        workerMocks.instances.splice(0, workerMocks.instances.length);
        delete process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS;
        delete process.env.EVB_SEARCH_WORKER_MAX_ACTIVE;
        delete process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles path cancellation only after the worker acknowledges cancellation', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const settled = vi.fn();
        void searchPromise.then(settled, settled);

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'search'}));
        expect(service.cancelRequestsForPdfPath('/tmp/other.pdf', 'revision changed')).toBe(0);
        expect(service.cancelRequestsForPdfPath('/tmp/work.pdf', 'revision changed')).toBe(1);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        emitWorkerCancelled(0, 'search-1');

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            requestId: 'search-1',
        });

        service.cleanupAll('test cleanup');
    });

    it('settles cancellation through a bounded fallback when the worker does not acknowledge it', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_CANCEL_ACK_TIMEOUT_MS = '100';
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        const settled = vi.fn();
        void searchPromise.then(settled, settled);

        expect(service.cancel({
            sender,
            senderId: 42,
        }, 'search-1')).toEqual({canceled: true});
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
            canceled: true,
        });
    });

    it('sends cooperative cancel messages before hard worker termination during cleanup', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_TERMINATE_TIMEOUT_MS = '1000';
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        service.cleanupAll('test shutdown');

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            requestId: 'search-1',
        });
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
        await expect(searchPromise).rejects.toThrow('test shutdown');

        await vi.advanceTimersByTimeAsync(999);
        expect(workerMocks.instances[0]?.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(workerMocks.instances[0]?.terminate).toHaveBeenCalledTimes(1);
    });

    it('does not let stale worker errors clean up a newer sender state', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const firstSearch = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        emitWorkerComplete(0, 'search-1');
        await expect(firstSearch).resolves.toEqual({
            results: [],
            truncated: false,
        });

        service.cleanupAll('retire old worker');
        const secondSearch = dispatchSearch(service, sender, 'search-2', {senderId: 42});
        expect(workerMocks.instances).toHaveLength(2);

        workerMocks.instances[0]?.emit('error', new Error('late old worker error'));
        emitWorkerComplete(1, 'search-2');

        await expect(secondSearch).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('returns an existing warmup singleflight before allocating sender worker state', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const firstSender = createSender(41);
        const secondSender = createSender(42);

        const firstWarmup = dispatchSearch(service, firstSender, 'warm-1', {
            senderId: 41,
            warmup: true,
        });
        const secondWarmup = dispatchSearch(service, secondSender, 'warm-2', {
            senderId: 42,
            warmup: true,
        });

        expect(secondWarmup).toBe(firstWarmup);
        expect(workerMocks.instances).toHaveLength(1);
        expect(secondSender.once).not.toHaveBeenCalled();

        emitWorkerComplete(0, 'warm-1');
        await expect(firstWarmup).resolves.toEqual({
            results: [],
            truncated: false,
        });
        await expect(secondWarmup).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('does not create unhandled rejections when warmup cleanup follows a worker error', async () => {
        const unhandledRejection = vi.fn();
        process.once('unhandledRejection', unhandledRejection);
        try {
            const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
            const service = new SearchWorkerService(() => '/tmp/search-worker.js');
            const sender = createSender(42);

            const warmupPromise = dispatchSearch(service, sender, 'warm-1', {
                senderId: 42,
                warmup: true,
            });
            workerMocks.instances[0]?.emit('message', {
                type: 'error',
                requestId: 'warm-1',
                error: 'warmup failed',
            });

            await expect(warmupPromise).rejects.toThrow('warmup failed');
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.removeListener('unhandledRejection', unhandledRejection);
        }
    });

    it('relays streamed result delta start indexes from worker progress', async () => {
        const { SEARCH_EVENT_CHANNELS } = await import('@electron/features/search/contract');
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const searchPromise = dispatchSearch(service, sender, 'search-1', {senderId: 42});
        workerMocks.instances[0]?.emit('message', {
            type: 'progress',
            requestId: 'search-1',
            processed: 4,
            total: 10,
            resultsStartIndex: 1,
            results: [{
                pageNumber: 2,
                pageMatchIndex: 0,
                matchIndex: 1,
                startOffset: 5,
                endOffset: 11,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: '',
                    match: 'needle',
                    after: '',
                },
            }],
            truncated: false,
        });

        expect(electronMocks.send).toHaveBeenCalledWith(
            SEARCH_EVENT_CHANNELS.progress,
            expect.objectContaining({
                requestId: 'search-1',
                resultsStartIndex: 1,
                results: [expect.objectContaining({matchIndex: 1})],
            }),
        );

        emitWorkerComplete(0, 'search-1');
        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('disposes the old sender cleanup when re-keying an idle worker under cap pressure', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '1';
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const firstSender = createSender(41);
        const secondSender = createSender(42);

        const firstSearch = dispatchSearch(service, firstSender, 'search-1', {senderId: 41});
        emitWorkerComplete(0, 'search-1');
        await expect(firstSearch).resolves.toEqual({
            results: [],
            truncated: false,
        });

        const secondSearch = dispatchSearch(service, secondSender, 'search-2', {
            senderId: 42,
            pdfPath: '/tmp/other.pdf',
        });

        expect(workerMocks.instances).toHaveLength(1);
        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith({type: 'reset-state'});
        expect(firstSender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(firstSender.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(firstSender.removeListener).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));

        emitWorkerComplete(0, 'search-2');
        await expect(secondSearch).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });
});
