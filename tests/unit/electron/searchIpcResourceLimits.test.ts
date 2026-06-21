import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';


interface ISearchResourceLimitMockWorkerRecord {
    onHandlers: Map<string, Array<(arg: unknown) => void>>;
    postMessageCalls: Array<Record<string, unknown>>;
    terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    workerRecords: [] as ISearchResourceLimitMockWorkerRecord[],
    workerCtor: vi.fn(),
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    appOn: vi.fn(),
    webContentsById: new Map<number, {
        isDestroyed: () => boolean;
        send: ReturnType<typeof vi.fn>
    }>(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    autoCompleteSearch: true,
    existsSync: vi.fn(),
}));

function emitWorkerEvent(
    workerIndex: number,
    event: string,
    payload: unknown,
) {
    const record = mocks.workerRecords[workerIndex];
    if (!record) {
        throw new Error(`Worker record ${workerIndex} not found`);
    }

    const handlers = record.onHandlers.get(event) ?? [];
    for (const handler of handlers) {
        handler(payload);
    }
}

function emitWorkerComplete(
    workerIndex: number,
    requestId: string,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'complete',
        requestId,
        response: {
            results: [],
            truncated: false,
        },
    });
}

function buildSearchMatch(overrides: Record<string, unknown> = {}) {
    return {
        pageNumber: 1,
        pageMatchIndex: 0,
        matchIndex: 0,
        startOffset: 2,
        endOffset: 6,
        excerpt: {
            prefix: false,
            suffix: false,
            before: '',
            match: 'test',
            after: '',
        },
        ...overrides,
    };
}

function emitWorkerCompleteWithResults(
    workerIndex: number,
    requestId: string,
    results: Array<Record<string, unknown>>,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'complete',
        requestId,
        response: {
            results,
            truncated: false,
        },
    });
}

function emitWorkerProgressWithResults(
    workerIndex: number,
    requestId: string,
    results: Array<Record<string, unknown>>,
) {
    emitWorkerEvent(workerIndex, 'message', {
        type: 'progress',
        requestId,
        processed: 1,
        total: 2,
        results,
        truncated: false,
    });
}

vi.mock('worker_threads', () => ({Worker: class {
    private record: ISearchResourceLimitMockWorkerRecord;

    constructor(workerPath: string) {
        this.record = {
            onHandlers: new Map(),
            postMessageCalls: [],
            terminate: vi.fn(async () => 0),
        };
        mocks.workerCtor(workerPath);
        mocks.workerRecords.push(this.record);
    }

    on(event: string, handler: (arg: unknown) => void) {
        const handlers = this.record.onHandlers.get(event) ?? [];
        handlers.push(handler);
        this.record.onHandlers.set(event, handlers);
        return this;
    }

    postMessage(message: Record<string, unknown>) {
        this.record.postMessageCalls.push(message);

        if (mocks.autoCompleteSearch && message.type === 'search') {
            const payload = message.payload as { requestId?: string } | undefined;
            const requestId = payload?.requestId;
            if (typeof requestId === 'string' && requestId.length > 0) {
                void Promise.resolve().then(() => {
                    emitWorkerComplete(mocks.workerRecords.indexOf(this.record), requestId);
                });
            }
        }
    }

    terminate() {
        return this.record.terminate();
    }
}}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: (...args: unknown[]) => mocks.appOn(...args),
    },
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.handlers.set(channel, handler);
    }},
    webContents: {fromId: (senderId: number) => mocks.webContentsById.get(senderId) ?? null},
}));

vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('fs', () => ({existsSync: (...args: unknown[]) => mocks.existsSync(...args)}));

function createInvokeEvent(senderId: number) {
    const sender = {
        id: senderId,
        once: vi.fn(),
    };
    mocks.webContentsById.set(senderId, {
        isDestroyed: () => false,
        send: vi.fn(),
    });
    return {sender};
}

function getSearchHandler() {
    const handler = mocks.handlers.get('pdf:search');
    if (!handler) {
        throw new Error('pdf:search handler is not registered');
    }
    return handler;
}

function getCancelHandler() {
    const handler = mocks.handlers.get('pdf:search:cancel');
    if (!handler) {
        throw new Error('pdf:search:cancel handler is not registered');
    }
    return handler;
}

describe('search IPC worker resource limits', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.workerRecords.length = 0;
        mocks.webContentsById.clear();
        mocks.autoCompleteSearch = true;

        delete process.env.EVB_SEARCH_WORKER_MAX_ACTIVE;
        delete process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS;
        delete process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS;

        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/allowed.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.existsSync.mockReturnValue(false);
    });

    it('fails fast when cap is reached and no idle worker can be reused', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '1';
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstRequest = searchHandler(
            createInvokeEvent(10),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: 'req-1',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean 
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        const secondRequest = searchHandler(
            createInvokeEvent(20),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'second',
                requestId: 'req-2',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean 
        }>;

        await expect(secondRequest).rejects.toThrow('Search worker limit reached (1 active senders)');
        expect(mocks.workerRecords).toHaveLength(1);

        emitWorkerComplete(0, 'req-1');
        await expect(firstRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('reuses an idle worker under cap pressure instead of spawning a new one', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '1';

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(31),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'alpha',
                requestId: 'req-a',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        await expect(searchHandler(
            createInvokeEvent(32),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'beta',
                requestId: 'req-b',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.workerRecords).toHaveLength(1);
        const searchRequestIds = mocks.workerRecords[0]?.postMessageCalls
            .filter(message => message.type === 'search')
            .map(message => (message.payload as { requestId?: string }).requestId);
        expect(searchRequestIds).toEqual([
            'req-a',
            'req-b',
        ]);
    });

    it('keeps normal per-sender search flow unchanged', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstResponse = await searchHandler(
            createInvokeEvent(77),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId: 'req-1',
            },
        );
        const secondResponse = await searchHandler(
            createInvokeEvent(77),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId: 'req-2',
            },
        );

        expect(firstResponse).toEqual({
            results: [],
            truncated: false,
        });
        expect(secondResponse).toEqual({
            results: [],
            truncated: false,
        });
        expect(mocks.workerRecords).toHaveLength(1);
    });

    it.each([
        {
            label: 'zero',
            pageNumber: 0,
        },
        {
            label: 'negative',
            pageNumber: -1,
        },
        {
            label: 'fractional',
            pageNumber: 1.5,
        },
    ])('ignores complete messages with $label worker pageNumber', async ({
        label,
        pageNumber,
    }) => {
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = `invalid-page-${label}`;
        const searchPromise = searchHandler(
            createInvokeEvent(170),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;
        let settled = false;
        void searchPromise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerCompleteWithResults(0, requestId, [buildSearchMatch({pageNumber})]);
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 170');

        const validResult = buildSearchMatch({pageNumber: 2});
        emitWorkerCompleteWithResults(0, requestId, [validResult]);

        await expect(searchPromise).resolves.toEqual({
            results: [validResult],
            truncated: false,
        });
    });

    it('ignores complete messages with worker pageNumber above known pageCount', async () => {
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = 'complete-page-number-above-count';
        const searchPromise = searchHandler(
            createInvokeEvent(172),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
                pageCount: 2,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;
        let settled = false;
        void searchPromise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        emitWorkerCompleteWithResults(0, requestId, [buildSearchMatch({pageNumber: 999})]);
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 172');

        const validResult = buildSearchMatch({pageNumber: 2});
        emitWorkerCompleteWithResults(0, requestId, [validResult]);

        await expect(searchPromise).resolves.toEqual({
            results: [validResult],
            truncated: false,
        });
    });

    it('ignores progress messages with invalid result indices and offsets', async () => {
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const event = createInvokeEvent(171);
        const requestId = 'invalid-progress-result';
        const searchPromise = searchHandler(
            event,
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        const sender = mocks.webContentsById.get(171);
        if (!sender) {
            throw new Error('Expected sender webContents mock');
        }

        const invalidProgressResultOverrides = [
            {pageMatchIndex: -1},
            {pageMatchIndex: 0.5},
            {matchIndex: -1},
            {matchIndex: 0.5},
            {startOffset: -1},
            {startOffset: 2.5},
            {endOffset: -1},
            {endOffset: 6.5},
            {
                startOffset: 8,
                endOffset: 6,
            },
        ];

        for (const overrides of invalidProgressResultOverrides) {
            emitWorkerEvent(0, 'message', {
                type: 'progress',
                requestId,
                processed: 1,
                total: 2,
                results: [buildSearchMatch(overrides)],
                truncated: false,
            });
        }

        expect(sender.send).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledTimes(invalidProgressResultOverrides.length);

        const validResult = buildSearchMatch();
        emitWorkerEvent(0, 'message', {
            type: 'progress',
            requestId,
            processed: 1,
            total: 2,
            results: [validResult],
            truncated: false,
        });
        expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
            requestId,
            processed: 1,
            total: 2,
            results: [validResult],
            truncated: false,
        });

        emitWorkerComplete(0, requestId);
        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('ignores progress messages with worker pageNumber above known pageCount', async () => {
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();
        const requestId = 'progress-page-number-above-count';
        const searchPromise = searchHandler(
            createInvokeEvent(173),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'needle',
                requestId,
                pageCount: 2,
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(1);
        });

        const sender = mocks.webContentsById.get(173);
        if (!sender) {
            throw new Error('Expected sender webContents mock');
        }

        emitWorkerEvent(0, 'message', {
            type: 'progress',
            requestId,
            processed: 1,
            total: 2,
            results: [buildSearchMatch({pageNumber: 999})],
            truncated: false,
        });
        await Promise.resolve();

        expect(sender.send).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith('Search worker sent malformed message for sender 173');

        const validResult = buildSearchMatch({pageNumber: 2});
        emitWorkerEvent(0, 'message', {
            type: 'progress',
            requestId,
            processed: 1,
            total: 2,
            results: [validResult],
            truncated: false,
        });
        expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
            requestId,
            processed: 1,
            total: 2,
            results: [validResult],
            truncated: false,
        });

        emitWorkerComplete(0, requestId);
        await expect(searchPromise).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it.each([
        {
            mode: 'complete',
            requestId: 'late-progress-after-complete',
            senderId: 174,
        },
        {
            mode: 'cancel',
            requestId: 'late-progress-after-cancel',
            senderId: 175,
        },
        {
            mode: 'timeout',
            requestId: 'late-progress-after-timeout',
            senderId: 176,
        },
    ] as const)('ignores late progress after $mode cleanup', async ({
        mode,
        requestId,
        senderId,
    }) => {
        mocks.autoCompleteSearch = false;
        if (mode === 'timeout') {
            vi.useFakeTimers();
            process.env.EVB_SEARCH_REQUEST_TIMEOUT_MS = '5000';
        }

        try {
            const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
            registerSearchHandlers();
            const searchHandler = getSearchHandler();
            const cancelHandler = getCancelHandler();
            const event = createInvokeEvent(senderId);
            const searchPromise = searchHandler(
                event,
                {
                    pdfPath: '/tmp/one.pdf',
                    query: 'needle',
                    requestId,
                    pageCount: 2,
                },
            ) as Promise<{
                results: unknown[];
                truncated: boolean
            }>;

            await vi.waitFor(() => {
                expect(mocks.workerRecords).toHaveLength(1);
            });

            const sender = mocks.webContentsById.get(senderId);
            if (!sender) {
                throw new Error('Expected sender webContents mock');
            }

            const validResult = buildSearchMatch({pageNumber: 2});
            emitWorkerProgressWithResults(0, requestId, [validResult]);
            expect(sender.send).toHaveBeenCalledWith('pdf:search:progress', {
                requestId,
                processed: 1,
                total: 2,
                results: [validResult],
                truncated: false,
            });
            sender.send.mockClear();
            mocks.logger.warn.mockClear();

            if (mode === 'complete') {
                emitWorkerComplete(0, requestId);
                await expect(searchPromise).resolves.toEqual({
                    results: [],
                    truncated: false,
                });
            } else if (mode === 'cancel') {
                expect(cancelHandler(event, requestId)).toEqual({ canceled: true });
                await expect(searchPromise).resolves.toEqual({
                    results: [],
                    truncated: false,
                });
            } else {
                const timeoutRejection = expect(searchPromise)
                    .rejects.toThrow('Search request timed out after 5000ms');
                await vi.advanceTimersByTimeAsync(5_000);
                await timeoutRejection;
                expect(mocks.workerRecords[0]?.terminate).toHaveBeenCalledTimes(1);
            }

            emitWorkerProgressWithResults(0, requestId, [buildSearchMatch({pageNumber: 999})]);
            await Promise.resolve();

            expect(sender.send).not.toHaveBeenCalled();
            expect(mocks.logger.warn).not.toHaveBeenCalled();
        } finally {
            if (mode === 'timeout') {
                vi.useRealTimers();
            }
        }
    });

    it('rejects oversized literal queries before resolving paths or spawning workers', async () => {
        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(78),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'x'.repeat(2_049),
                requestId: 'oversized-literal',
            },
        )).rejects.toThrow('maximum length is 2048 characters');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('precompiles regex queries before dispatching to a worker', async () => {
        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(79),
            {
                pdfPath: '/tmp/one.pdf',
                query: '(',
                requestId: 'invalid-regex',
                useRegex: true,
            },
        )).rejects.toThrow('Invalid search regex');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('rejects unsafe regex queries before resolving paths or spawning workers', async () => {
        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(80),
            {
                pdfPath: '/tmp/one.pdf',
                query: '(a+)+$',
                requestId: 'unsafe-regex',
                useRegex: true,
            },
        )).rejects.toThrow('pattern is too complex for document search');

        expect(mocks.resolveAllowedReadPath).not.toHaveBeenCalled();
        expect(mocks.workerRecords).toHaveLength(0);
    });

    it('caps the default active worker budget at two concurrent senders', async () => {
        mocks.autoCompleteSearch = false;

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        const firstRequest = searchHandler(
            createInvokeEvent(101),
            {
                pdfPath: '/tmp/one.pdf',
                query: 'first',
                requestId: 'req-a',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean;
        }>;

        const secondRequest = searchHandler(
            createInvokeEvent(102),
            {
                pdfPath: '/tmp/two.pdf',
                query: 'second',
                requestId: 'req-b',
            },
        ) as Promise<{
            results: unknown[];
            truncated: boolean;
        }>;

        await vi.waitFor(() => {
            expect(mocks.workerRecords).toHaveLength(2);
        });

        await expect(searchHandler(
            createInvokeEvent(103),
            {
                pdfPath: '/tmp/three.pdf',
                query: 'third',
                requestId: 'req-c',
            },
        )).rejects.toThrow('Search worker limit reached (2 active senders)');

        emitWorkerComplete(0, 'req-a');
        emitWorkerComplete(1, 'req-b');
        await expect(firstRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
        await expect(secondRequest).resolves.toEqual({
            results: [],
            truncated: false,
        });
    });

    it('re-arms idle cleanup after explicit cancel so the worker can be reclaimed', async () => {
        vi.useFakeTimers();
        process.env.EVB_SEARCH_WORKER_IDLE_TTL_MS = '10000';
        mocks.autoCompleteSearch = false;

        try {
            const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
            registerSearchHandlers();
            const searchHandler = getSearchHandler();
            const cancelHandler = getCancelHandler();
            const event = createInvokeEvent(41);

            const searchPromise = searchHandler(
                event,
                {
                    pdfPath: '/tmp/cancel-me.pdf',
                    query: 'gamma',
                    requestId: 'req-cancel',
                },
            ) as Promise<{
                results: unknown[];
                truncated: boolean;
            }>;

            await vi.waitFor(() => {
                expect(mocks.workerRecords).toHaveLength(1);
            });

            expect(cancelHandler(event, 'req-cancel')).toEqual({ canceled: true });
            await expect(searchPromise).resolves.toEqual({
                results: [],
                truncated: false,
            });

            await vi.advanceTimersByTimeAsync(10_000);

            expect(mocks.workerRecords[0]?.terminate).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('dispatches huge PDFs to the search worker instead of declaring search unavailable by file size', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(99),
            {
                pdfPath: '/tmp/large.pdf',
                query: 'needle',
                requestId: 'large-req',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });
        expect(mocks.workerRecords).toHaveLength(1);
    });

    it('prefers the active working copy for original-path searches', async () => {
        process.env.EVB_SEARCH_WORKER_MAX_ACTIVE = '4';
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/work/large.pdf');
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);

        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const searchHandler = getSearchHandler();

        await expect(searchHandler(
            createInvokeEvent(101),
            {
                pdfPath: '/Users/example/large.pdf',
                query: 'needle',
                requestId: 'original-path-req',
            },
        )).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(mocks.workerRecords[0]?.postMessageCalls[0]?.payload)
            .toEqual(expect.objectContaining({pdfPath: '/tmp/work/large.pdf'}));
    });
});
