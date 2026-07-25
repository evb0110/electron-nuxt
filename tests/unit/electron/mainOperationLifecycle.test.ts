import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {getMainOperationErrorEnvelope} from '@contracts/mainOperationErrors';
import {
    beginMainOperationShutdown,
    cancelAbortableMainOperationsForWorkingCopy,
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

    it('cancels only the abortable work bound to a closing working copy', async () => {
        const cleanupCancel = vi.fn();
        const cleanup = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
            cancel: cleanupCancel,
        });
        const otherDocument = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/other.pdf',
            cancel: vi.fn(),
        });
        const materializationFlight = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: '/tmp/closing.pdf',
        });
        const pendingWrite = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/closing.pdf',
        });

        expect(cancelAbortableMainOperationsForWorkingCopy('/tmp/closing.pdf', 'Working copy is closing')).toBe(1);
        await Promise.resolve();

        expect(cleanup.signal.aborted).toBe(true);
        expect(cleanupCancel).toHaveBeenCalledWith('Working copy is closing');
        expect(otherDocument.signal.aborted).toBe(false);
        expect(materializationFlight.signal.aborted).toBe(false);
        expect(pendingWrite.signal.aborted).toBe(false);
    });

    it('completes operations idempotently', () => {
        const operation = registerMainOperation({kind: 'resource-cleanup'});

        operation.complete();
        operation.complete();

        expect(snapshotMainOperations()).toEqual([]);
    });

    it('rejects registrations after shutdown admission closes without leaving drain orphans', async () => {
        beginMainOperationShutdown('Main process is shutting down');

        let caught: unknown;
        try {
            registerMainOperation({kind: 'critical-write'});
        } catch (error) {
            caught = error;
        }

        expect(getMainOperationErrorEnvelope(caught)).toEqual({
            code: 'shutting-down',
            message: 'Main process is shutting down',
        });
        await expect(drainCriticalMainOperations({timeoutMs: 50})).resolves.toEqual({
            completed: true,
            pending: [],
        });
        expect(snapshotMainOperations()).toEqual([]);
    });
});
