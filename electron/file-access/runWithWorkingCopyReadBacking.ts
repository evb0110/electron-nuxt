import {existsSync} from 'node:fs';
import {
    captureWorkingCopyAdmissionSnapshot,
    getWorkingCopyBackingEntry,
    runWithWorkingCopyRegistrationFence,
    transitionWorkingCopyBackingState,
    workingCopyAdmissionSnapshotsMatch,
    type IWorkingCopyOriginalEntry,
} from '@electron/file-access/workingCopyStore';
import {WorkingCopyMaterializationError} from '@electron/file-access/workingCopyMaterialization';

export interface IWorkingCopyReadBackingOptions<TResult> {
    discard?: (result: TResult) => Promise<void> | void;
    ownerWebContentsId?: number;
}

function throwBackingError(
    entry: IWorkingCopyOriginalEntry,
    logicalRef: string,
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
): never {
    transitionWorkingCopyBackingState(
        logicalRef,
        entry.registrationId,
        'lazy-original',
        {
            expectedBackingState: [
                'lazy-original',
                'materializing',
            ],
            sourceBackingErrorCode: code,
        },
    );
    throw new WorkingCopyMaterializationError(
        code,
        code === 'SOURCE_BACKING_CHANGED'
            ? 'The original document changed while it was being read'
            : 'The original document is unavailable',
        cause === undefined ? {} : {cause},
    );
}

async function assertOriginalBackingCurrent(
    entry: IWorkingCopyOriginalEntry,
    logicalRef: string,
) {
    if (!entry.admissionSnapshot) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Lazy working copy has no admission snapshot',
        );
    }
    let currentSnapshot;
    try {
        currentSnapshot = await captureWorkingCopyAdmissionSnapshot(entry.originalPath);
    } catch (error) {
        throwBackingError(entry, logicalRef, 'SOURCE_BACKING_UNAVAILABLE', error);
    }
    if (!workingCopyAdmissionSnapshotsMatch(currentSnapshot, entry.admissionSnapshot)) {
        throwBackingError(entry, logicalRef, 'SOURCE_BACKING_CHANGED');
    }
}

/**
 * Runs a read against the physical bytes behind one logical working-copy ref.
 * Lazy copies keep reading the immutable witnessed original while background
 * materialization proceeds. The registration fence prevents a close or reopen
 * from changing ownership during the read.
 */
export async function runWithWorkingCopyReadBacking<TResult>(
    logicalRef: string,
    operation: (physicalReadPath: string) => Promise<TResult>,
    options: IWorkingCopyReadBackingOptions<TResult> = {},
) {
    const entry = getWorkingCopyBackingEntry(logicalRef, options.ownerWebContentsId);
    if (!entry) {
        throw new Error('Working copy path is not managed');
    }
    const fenced = await runWithWorkingCopyRegistrationFence(
        logicalRef,
        entry.registrationId,
        async currentEntry => {
            const originalBacked = currentEntry.backingState === 'lazy-original'
                || currentEntry.backingState === 'materializing';
            if (!originalBacked) {
                if (!existsSync(logicalRef)) {
                    throw new Error(`Working copy not found: ${logicalRef}`);
                }
                return operation(logicalRef);
            }
            if (
                currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
                || currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
            ) {
                throw new WorkingCopyMaterializationError(
                    currentEntry.sourceBackingErrorCode,
                    currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
                        ? 'The original document changed after it was opened'
                        : 'The original document is unavailable',
                );
            }
            await assertOriginalBackingCurrent(currentEntry, logicalRef);
            const result = await operation(currentEntry.originalPath);
            try {
                await assertOriginalBackingCurrent(currentEntry, logicalRef);
            } catch (error) {
                await options.discard?.(result);
                throw error;
            }
            return result;
        },
    );
    if (!fenced.matched) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed during the read',
        );
    }
    return fenced.value;
}
