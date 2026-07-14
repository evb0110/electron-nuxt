import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
} from '@contracts/search';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createWorker: vi.fn(),
    searchWorkerText: vi.fn(),
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: mocks.createWorker,
    searchDjvuWorkerText: mocks.searchWorkerText,
}));

const { browserDjvuTextSearchCapability } = await import(
    '@app/platform/browser-api/browserDjvuTextSearchCapability'
);

interface ISearchWorkerOptionsForTest {
    onProgress?: (progress: IPdfSearchProgress) => void;
    requestId: string;
    signal: AbortSignal;
}

interface IWorkerForTest {
    source: string;
    terminate: ReturnType<typeof vi.fn>;
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function createSearchOptions(requestId: string) {
    return {
        requestId,
        pageCount: 1,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
    };
}

describe('browserDjvuTextSearchCapability', () => {
    const calls: Array<{
        deferred: ReturnType<typeof createDeferred<IPdfSearchResponse>>;
        options: ISearchWorkerOptionsForTest;
        worker: IWorkerForTest;
    }> = [];

    beforeEach(() => {
        calls.length = 0;
        vi.clearAllMocks();
        mocks.createWorker.mockImplementation(async (source: string) => ({
            source,
            terminate: vi.fn(),
        }));
        mocks.searchWorkerText.mockImplementation((
            worker: IWorkerForTest,
            options: ISearchWorkerOptionsForTest,
        ) => {
            const deferred = createDeferred<IPdfSearchResponse>();
            calls.push({
                deferred,
                options,
                worker,
            });
            return deferred.promise;
        });
    });

    it('lets the same request ID run concurrently on different document sources and cancels all matches', async () => {
        const requestId = 'shared-browser-search';
        const firstRun = browserDjvuTextSearchCapability.searchText(
            'browser://documents/first.djvu',
            'needle',
            createSearchOptions(requestId),
        );
        const secondRun = browserDjvuTextSearchCapability.searchText(
            'browser://documents/second.djvu',
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(2));

        expect(calls[0]!.options.signal.aborted).toBe(false);
        expect(calls[1]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[0]!.options.signal.aborted).toBe(true);
        expect(calls[1]!.options.signal.aborted).toBe(true);

        const replacementRun = browserDjvuTextSearchCapability.searchText(
            'browser://documents/replacement.djvu',
            'needle',
            createSearchOptions(requestId),
        );
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[0]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        calls[1]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await Promise.all([
            firstRun,
            secondRun,
        ]);

        expect(calls[2]!.options.signal.aborted).toBe(false);
        await expect(browserDjvuTextSearchCapability.cancelTextSearch(requestId))
            .resolves.toEqual({canceled: true});
        expect(calls[2]!.options.signal.aborted).toBe(true);
        calls[2]!.deferred.resolve({
            results: [],
            truncated: false,
        });
        await replacementRun;
        expect(calls.map(call => call.worker.terminate.mock.calls.length)).toEqual([
            1,
            1,
            1,
        ]);
    });

    it('supersedes only the same source generation and suppresses its late progress', async () => {
        const requestId = 'same-source-browser-search';
        const progress: IPdfSearchProgress[] = [];
        const unsubscribe = browserDjvuTextSearchCapability.onTextSearchProgress((event) => {
            progress.push(event);
        });
        try {
            const firstRun = browserDjvuTextSearchCapability.searchText(
                'browser://documents/book.djvu',
                'first',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const currentRun = browserDjvuTextSearchCapability.searchText(
                'browser://documents/book.djvu',
                'current',
                createSearchOptions(requestId),
            );
            await vi.waitFor(() => expect(calls).toHaveLength(2));

            expect(calls[0]!.options.signal.aborted).toBe(true);
            expect(calls[1]!.options.signal.aborted).toBe(false);
            calls[0]!.options.onProgress?.({
                requestId,
                processed: 99,
                total: 100,
                status: 'running',
            });
            calls[1]!.options.onProgress?.({
                requestId,
                processed: 1,
                total: 100,
                status: 'running',
            });

            calls[0]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            calls[1]!.deferred.resolve({
                results: [],
                truncated: false,
            });
            await Promise.all([
                firstRun,
                currentRun,
            ]);
            expect(progress.map(event => event.processed)).toEqual([1]);
        } finally {
            unsubscribe();
        }
    });
});
