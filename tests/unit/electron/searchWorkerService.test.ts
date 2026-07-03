import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const workerMocks = vi.hoisted(() => ({instances: [] as Array<{
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
}>}));

const electronMocks = vi.hoisted(() => ({send: vi.fn()}));

vi.mock('electron', () => ({webContents: {fromId: vi.fn(() => ({
    isDestroyed: () => false,
    send: electronMocks.send,
}))}}));

vi.mock('worker_threads', () => {
    class MockWorker {
        postMessage = vi.fn();
        terminate = vi.fn(async () => undefined);

        constructor() {
            workerMocks.instances.push(this);
        }

        on() {
            return this;
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

describe('SearchWorkerService', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        workerMocks.instances.splice(0, workerMocks.instances.length);
    });

    it('cancels pending search requests for a changed PDF path', async () => {
        const { SearchWorkerService } = await import('@electron/features/search/main/searchWorkerService');
        const service = new SearchWorkerService(() => '/tmp/search-worker.js');
        const sender = createSender(42);

        const searchPromise = service.dispatchSearchRequest(
            {
                sender,
                senderId: 42,
            },
            {
                resolvedPdfPath: '/tmp/work.pdf',
                documentRevision: 'revision-token',
                query: 'term',
                requestId: 'search-1',
                requestIdPrefix: 'search',
            },
        );

        expect(workerMocks.instances[0]?.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'search'}));
        expect(service.cancelRequestsForPdfPath('/tmp/other.pdf', 'revision changed')).toBe(0);
        expect(service.cancelRequestsForPdfPath('/tmp/work.pdf', 'revision changed')).toBe(1);

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
});
