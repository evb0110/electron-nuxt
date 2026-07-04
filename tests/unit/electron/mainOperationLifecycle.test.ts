import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    cancelAllMainOperations,
    drainCriticalMainOperations,
    registerMainOperation,
    resetMainOperationLifecycleForTests,
    snapshotMainOperations,
} from '@electron/operation-lifecycle/mainOperationLifecycle';

describe('mainOperationLifecycle', () => {
    afterEach(() => {
        resetMainOperationLifecycleForTests();
        vi.useRealTimers();
    });

    it('aborts registered noncommitting operations during shutdown cancel', () => {
        const cancel = vi.fn();
        const operation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            cancel,
        });

        cancelAllMainOperations('app shutdown');

        expect(operation.signal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledWith('app shutdown');
        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            id: operation.id,
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            aborted: true,
        })]);
    });

    it('does not abort critical writes after commit starts and drains until completion', async () => {
        const operation = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/working.pdf',
        });
        operation.markCommitStarted();

        cancelAllMainOperations('app shutdown');
        const drainPromise = drainCriticalMainOperations({timeoutMs: 1000});
        await Promise.resolve();

        expect(operation.signal.aborted).toBe(false);
        expect(snapshotMainOperations()).toHaveLength(1);

        operation.complete();

        await expect(drainPromise).resolves.toEqual({
            completed: true,
            pending: [],
        });
    });

    it('times out while critical writes remain pending', async () => {
        vi.useFakeTimers();
        registerMainOperation({kind: 'critical-write'});

        const drainPromise = drainCriticalMainOperations({timeoutMs: 50});
        await vi.advanceTimersByTimeAsync(50);

        const result = await drainPromise;
        expect(result.completed).toBe(false);
        expect(result.pending).toHaveLength(1);
    });

    it('completes operations idempotently', () => {
        const operation = registerMainOperation({kind: 'resource-cleanup'});

        operation.complete();
        operation.complete();

        expect(snapshotMainOperations()).toEqual([]);
    });
});
