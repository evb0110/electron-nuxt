import {abortErrorFromSignal} from '@electron/utils/abort';

export const LARGE_PDF_MUTATION_THRESHOLD_BYTES = 512 * 1024 * 1024;

let largePdfMutationTail: Promise<void> = Promise.resolve();

/** Keeps eager native parsers for separate large documents from overlapping. */
export function withLargePdfMutationAdmission<T>(
    sourceBytes: number,
    signal: AbortSignal,
    operation: () => Promise<T>,
): Promise<T> {
    if (sourceBytes <= LARGE_PDF_MUTATION_THRESHOLD_BYTES) {
        return operation();
    }
    if (signal.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }

    let operationStarted = false;
    let removeAbortListener: () => void = () => undefined;
    const queuedResult = largePdfMutationTail.then(() => {
        if (signal.aborted) {
            throw abortErrorFromSignal(signal);
        }
        operationStarted = true;
        removeAbortListener();
        return operation();
    });
    largePdfMutationTail = queuedResult.then(() => undefined, () => undefined);

    const aborted = new Promise<never>((_resolve, reject) => {
        const handleAbort = () => {
            if (!operationStarted) {
                reject(abortErrorFromSignal(signal));
            }
        };
        removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
        signal.addEventListener('abort', handleAbort, {once: true});
    });
    return Promise.race([
        queuedResult,
        aborted,
    ]).finally(removeAbortListener);
}
