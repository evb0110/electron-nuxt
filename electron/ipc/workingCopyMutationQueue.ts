import {
    rm,
    unlink,
} from 'fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('workingCopyMutationQueue');
const workingCopyMutationQueue = new Map<string, Promise<void>>();

export function enqueueWorkingCopyMutation<T>(
    workingCopyPath: string,
    operation: () => Promise<T>,
) {
    const previousTail = workingCopyMutationQueue.get(workingCopyPath) ?? Promise.resolve();
    const operationPromise = previousTail.then(operation);

    const nextTail = operationPromise
        .then(() => undefined, () => undefined)
        .finally(() => {
            if (workingCopyMutationQueue.get(workingCopyPath) === nextTail) {
                workingCopyMutationQueue.delete(workingCopyPath);
            }
        });

    workingCopyMutationQueue.set(workingCopyPath, nextTail);
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
    ]);
}
