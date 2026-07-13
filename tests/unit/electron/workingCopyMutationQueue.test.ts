import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    complete: vi.fn(),
    nextOperationId: 0,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: (...args: unknown[]) => mocks.debug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.warn(...args),
    error: vi.fn(),
})}));
vi.mock('@electron/file-access/workingCopyStore', () => ({normalizePathForLookup: (path: string) => path.trim().toLowerCase()}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: vi.fn()}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({registerMainOperation: () => {
    mocks.nextOperationId += 1;
    return {
        id: `operation-${mocks.nextOperationId}`,
        signal: new AbortController().signal,
        markCommitStarted: vi.fn(),
        complete: (...args: unknown[]) => mocks.complete(...args),
    };
}}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', () => ({runWithWorkingCopyMutationCommitSignal: (_operation: unknown, callback: () => Promise<unknown>) => callback()}));
vi.mock('@electron/search/searchIndexSidecar', () => ({getCompactSearchIndexPath: (path: string) => `${path}.compact-index`}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

function parseLog(prefix: string, calls: unknown[][]) {
    const message = calls
        .map(call => call[0])
        .find(value => typeof value === 'string' && value.startsWith(prefix));
    expect(message).toBeTypeOf('string');
    return JSON.parse((message as string).slice(prefix.length)) as Record<string, unknown>;
}

describe('workingCopyMutationQueue telemetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.nextOperationId = 0;
    });

    it('reports the queued and active owner and clears ownership after settlement', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blocker = deferred<undefined>();
        const first = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => blocker.promise, {kind: 'first-write'});
        await Promise.resolve();
        const second = enqueueWorkingCopyMutation('/tmp/book.pdf', async () => undefined, {kind: 'second-write'});

        const secondEnqueue = parseLog('Working-copy mutation enqueued: ', mocks.warn.mock.calls);
        expect(secondEnqueue).toMatchObject({
            queueKey: '/tmp/book.pdf',
            operationId: 'operation-2',
            kind: 'second-write',
            depth: 2,
            queuedBehind: {
                operationId: 'operation-1',
                kind: 'first-write',
            },
            activeOwner: {
                operationId: 'operation-1',
                kind: 'first-write',
            },
        });
        expect(mocks.warn).toHaveBeenCalledTimes(1);

        blocker.resolve(undefined);
        await Promise.all([
            first,
            second,
        ]);

        const third = enqueueWorkingCopyMutation('/tmp/book.pdf', async () => undefined, {kind: 'third-write'});
        const thirdEnqueue = parseLog('Working-copy mutation enqueued: ', mocks.debug.mock.calls.slice(-1));
        expect(thirdEnqueue).toMatchObject({
            operationId: 'operation-3',
            kind: 'third-write',
            depth: 1,
            queuedBehind: null,
            activeOwner: null,
        });
        await third;
        expect(mocks.complete).toHaveBeenCalledTimes(3);
    });
});
