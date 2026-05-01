import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TRegisteredHandler = (...args: unknown[]) => unknown;

interface IMockWorkerRecord {
    onHandlers: Map<string, Array<(arg: unknown) => void>>;
    postMessageCalls: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    workerRecords: [] as IMockWorkerRecord[],
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
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

vi.mock('worker_threads', () => ({Worker: class {
    private record: IMockWorkerRecord;

    constructor() {
        this.record = {
            onHandlers: new Map(),
            postMessageCalls: [],
        };
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
        if (message.type !== 'search') {
            return;
        }
        const payload = message.payload as { requestId?: string } | undefined;
        const requestId = payload?.requestId;
        if (!requestId) {
            return;
        }
        Promise.resolve().then(() => {
            emitWorkerEvent(
                mocks.workerRecords.indexOf(this.record),
                'message',
                {
                    type: 'complete',
                    requestId,
                    response: {
                        results: [],
                        truncated: false,
                    },
                },
            );
        });
    }

    terminate() {
        return Promise.resolve(0);
    }
}}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.handlers.set(channel, handler);
    }},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@electron/utils/path-validator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/ipc/workingCopy', () => ({findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

function createInvokeEvent(senderId: number) {
    return { sender: {
        id: senderId,
        once: vi.fn(),
    } };
}

describe('search warm-index IPC', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.workerRecords.length = 0;
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/allowed.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
    });

    it('routes warm-index requests through worker warmup mode', async () => {
        const { registerSearchHandlers } = await import('@electron/features/search/main/ipc');
        registerSearchHandlers();
        const warmIndexHandler = mocks.handlers.get('pdf:search:warmIndex');

        expect(warmIndexHandler).toBeTypeOf('function');
        await expect(warmIndexHandler?.(
            createInvokeEvent(111),
            {
                pdfPath: '/tmp/original.pdf',
                pageCount: 42,
                requestId: 'warm-req-1',
            },
        )).resolves.toBe(true);

        const firstWorker = mocks.workerRecords[0];
        expect(firstWorker).toBeDefined();

        expect(firstWorker?.postMessageCalls[0]).toEqual({
            type: 'search',
            payload: {
                requestId: 'warm-req-1',
                pdfPath: '/tmp/allowed.pdf',
                query: '',
                pageCount: 42,
                warmup: true,
            },
        });
    });
});
