import {
    rm,
    unlink,
} from 'fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getCompactSearchIndexPath } from '@electron/search/searchIndexSidecar';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { runWithWorkingCopyMutationCommitSignal } from '@electron/file-access/workingCopyMutationCommitSignal';

const log = createLogger('workingCopyMutationQueue');
const workingCopyMutationQueue = new Map<string, Promise<void>>();
const workingCopyMutationListeners = new Set<(workingCopyPath: string) => void>();

export interface IWorkingCopyMutationOperation {
    workingCopyPath: string;
    signal: AbortSignal;
    cancelGroup: string;
    markCommitStarted: () => void;
}

export function onWorkingCopyMutationSettled(listener: (workingCopyPath: string) => void) {
    workingCopyMutationListeners.add(listener);
    return () => {
        workingCopyMutationListeners.delete(listener);
    };
}

function notifyWorkingCopyMutationSettled(workingCopyPath: string) {
    for (const listener of workingCopyMutationListeners) {
        try {
            listener(workingCopyPath);
        } catch (error) {
            log.debug(`Failed to notify working copy mutation listener: ${getErrorMessage(error)}`);
        }
    }
}

function getWorkingCopyQueueKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

export async function drainWorkingCopyMutations(workingCopyPath?: string) {
    if (workingCopyPath !== undefined) {
        await (workingCopyMutationQueue.get(getWorkingCopyQueueKey(workingCopyPath)) ?? Promise.resolve());
        return;
    }

    while (workingCopyMutationQueue.size > 0) {
        await Promise.allSettled([...workingCopyMutationQueue.values()]);
    }
}

export function enqueueWorkingCopyMutation<T>(
    workingCopyPath: string,
    operation: (operation: IWorkingCopyMutationOperation) => Promise<T>,
) {
    const queueKey = getWorkingCopyQueueKey(workingCopyPath);
    const previousTail = workingCopyMutationQueue.get(queueKey) ?? Promise.resolve();
    let cancelGroup = '';
    const lifecycleOperation = registerMainOperation({
        kind: 'critical-write',
        workingCopyPath,
        cancel: () => {
            if (cancelGroup) {
                cancelNativeCommandGroup(cancelGroup);
            }
        },
    });
    cancelGroup = `working-copy-mutation:${lifecycleOperation.id}`;
    const mutationOperation: IWorkingCopyMutationOperation = {
        workingCopyPath,
        signal: lifecycleOperation.signal,
        cancelGroup,
        markCommitStarted: lifecycleOperation.markCommitStarted,
    };
    const operationPromise = previousTail
        .then(() => {
            if (mutationOperation.signal.aborted) {
                throw mutationOperation.signal.reason instanceof Error
                    ? mutationOperation.signal.reason
                    : new Error('Working-copy mutation canceled');
            }
            return runWithWorkingCopyMutationCommitSignal(mutationOperation, () => operation(mutationOperation));
        })
        .finally(() => {
            notifyWorkingCopyMutationSettled(workingCopyPath);
            lifecycleOperation.complete();
        });

    const nextTail = operationPromise
        .then(() => undefined, () => undefined)
        .finally(() => {
            if (workingCopyMutationQueue.get(queueKey) === nextTail) {
                workingCopyMutationQueue.delete(queueKey);
            }
        });

    workingCopyMutationQueue.set(queueKey, nextTail);
    return operationPromise;
}

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch (error) {
        const code = isErrnoException(error) ? error.code : undefined;
        if (code !== 'ENOENT') {
            log.debug(`Failed to remove page-op artifact "${filePath}": ${getErrorMessage(error)}`);
        }
    }
}

export async function clearWorkingCopyOcrArtifacts(workingCopyPath: string) {
    await Promise.all([
        rm(`${workingCopyPath}.ocr`, {
            recursive: true,
            force: true,
        }).catch(error => {
            log.debug(`Failed to remove OCR sidecar for page-op mutation: ${getErrorMessage(error)}`);
        }),
        unlinkIfPresent(`${workingCopyPath}.index.json`),
        unlinkIfPresent(getCompactSearchIndexPath(workingCopyPath)),
    ]);
}
