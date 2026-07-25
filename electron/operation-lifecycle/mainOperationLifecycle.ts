import { randomUUID } from 'node:crypto';
import { createMainOperationShuttingDownError } from '@contracts/mainOperationErrors';
import { createLogger } from '@electron/utils/createLogger';
import { runDetached } from '@electron/utils/runDetached';

export type TMainOperationKind = 'critical-write' | 'abortable-work' | 'resource-cleanup';

export interface IMainOperationRegistration {
    kind: TMainOperationKind;
    ownerWebContentsId?: number | undefined;
    workingCopyPath?: string | undefined;
    cancel?: ((reason: string) => void | Promise<void>) | undefined;
}

export interface IRegisteredMainOperation {
    id: string;
    signal: AbortSignal;
    markCommitStarted: () => void;
    complete: () => void;
}

export interface IMainOperationSnapshot {
    id: string;
    kind: TMainOperationKind;
    ownerWebContentsId?: number;
    workingCopyPath?: string;
    commitStarted: boolean;
    aborted: boolean;
}

interface IMainOperationRecord {
    id: string;
    kind: TMainOperationKind;
    ownerWebContentsId?: number | undefined;
    workingCopyPath?: string | undefined;
    cancel?: ((reason: string) => void | Promise<void>) | undefined;
    controller: AbortController;
    commitStarted: boolean;
    complete: () => void;
    done: Promise<void>;
}

const operations = new Map<string, IMainOperationRecord>();
const log = createLogger('main-operation-lifecycle');
let shutdownAdmissionMessage: string | null = null;

function createTimeoutPromise(timeoutMs: number): Promise<'timeout'> {
    return new Promise<'timeout'>(resolve => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
    });
}

export function registerMainOperation(
    registration: IMainOperationRegistration,
): IRegisteredMainOperation {
    if (shutdownAdmissionMessage !== null) {
        throw createMainOperationShuttingDownError(shutdownAdmissionMessage);
    }

    const id = randomUUID();
    const controller = new AbortController();
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const record: IMainOperationRecord = {
        id,
        kind: registration.kind,
        ownerWebContentsId: registration.ownerWebContentsId,
        workingCopyPath: registration.workingCopyPath,
        cancel: registration.cancel,
        controller,
        commitStarted: false,
        done,
        complete: () => {
            if (!operations.delete(id)) {
                return;
            }
            resolveDone?.();
        },
    };
    operations.set(id, record);

    return {
        id,
        signal: controller.signal,
        markCommitStarted: () => {
            const current = operations.get(id);
            if (current) {
                current.commitStarted = true;
            }
        },
        complete: record.complete,
    };
}

export function beginMainOperationShutdown(message = 'Main process is shutting down') {
    shutdownAdmissionMessage ??= message;
}

function requestOperationCancel(operation: IMainOperationRecord, reason: string) {
    if (!operation.controller.signal.aborted) {
        operation.controller.abort(new Error(reason));
    }
    if (operation.cancel) {
        runDetached(
            () => operation.cancel?.(reason),
            {
                label: `cancel ${operation.kind} operation ${operation.id}`,
                logger: log,
            },
        );
    }
}

export function cancelAllMainOperations(reason: string): void {
    for (const operation of operations.values()) {
        if (operation.kind === 'critical-write' && operation.commitStarted) {
            continue;
        }
        requestOperationCancel(operation, reason);
    }
}

// A working copy that is being retired can still be the source of long native
// work such as scan cleanup, OCR, or search indexing. Cancelling that work is
// what lets the close finish instead of deleting the file out from under a job
// that keeps burning CPU for minutes afterwards. Only operations that carry
// their own cancel hook qualify: a materialization flight registers without one
// because the close path decides on its own whether to join or cancel it.
export function cancelAbortableMainOperationsForWorkingCopy(workingCopyPath: string, reason: string) {
    let canceled = 0;
    for (const operation of operations.values()) {
        if (
            operation.kind !== 'abortable-work'
            || operation.workingCopyPath !== workingCopyPath
            || !operation.cancel
        ) {
            continue;
        }
        requestOperationCancel(operation, reason);
        canceled += 1;
    }
    return canceled;
}

export async function drainCriticalMainOperations(options: {timeoutMs: number}): Promise<{
    completed: boolean;
    pending: IMainOperationSnapshot[];
}> {
    const criticalWrites = [...operations.values()]
        .filter(operation => operation.kind === 'critical-write');
    if (criticalWrites.length === 0) {
        return {
            completed: true,
            pending: [],
        };
    }

    const completed = await Promise.race([
        Promise.allSettled(criticalWrites.map(operation => operation.done))
            .then(() => 'completed' as const),
        createTimeoutPromise(options.timeoutMs),
    ]);

    return {
        completed: completed === 'completed',
        pending: snapshotMainOperations()
            .filter(operation => operation.kind === 'critical-write'),
    };
}

export function snapshotMainOperations(): IMainOperationSnapshot[] {
    return [...operations.values()].map(operation => ({
        id: operation.id,
        kind: operation.kind,
        ...(operation.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: operation.ownerWebContentsId}),
        ...(operation.workingCopyPath === undefined ? {} : {workingCopyPath: operation.workingCopyPath}),
        commitStarted: operation.commitStarted,
        aborted: operation.controller.signal.aborted,
    }));
}

export function resetMainOperationLifecycleForTests(): void {
    shutdownAdmissionMessage = null;
    for (const operation of operations.values()) {
        operation.complete();
    }
    operations.clear();
}
