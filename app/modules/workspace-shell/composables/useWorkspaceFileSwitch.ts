import type { Ref } from 'vue';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    cleanupDjvuTemp: () => Promise<void>;
    exitDjvuMode: () => void;
    invalidatePendingDjvuOpen: () => void;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void;
}

export const useWorkspaceFileSwitch = (deps: IWorkspaceFileSwitchDeps) => {
    const {
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        invalidatePendingDjvuOpen,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    } = deps;

    async function pickFileToOpenWithDjvuCleanup() {
        return pickFileToOpen();
    }

    async function openFileWithDjvuCleanup(preSelected?: TOpenFileResult) {
        const oldPath = workingCopyPath.value;
        invalidatePendingDjvuOpen();
        const outcome = await openFile(preSelected);
        if (didOpenDocument(outcome) && isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
        return outcome;
    }

    async function openFileDirectWithDjvuCleanup(path: TDocumentRef) {
        const oldPath = workingCopyPath.value;
        invalidatePendingDjvuOpen();
        const outcome = await openFileDirect(path);
        if (didOpenDocument(outcome) && isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
        return outcome;
    }

    async function openFileDirectBatchWithDjvuCleanup(paths: TDocumentRef[]) {
        const oldPath = workingCopyPath.value;
        invalidatePendingDjvuOpen();
        const outcome = await openFileDirectBatch(paths);
        if (didOpenDocument(outcome) && isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
        return outcome;
    }

    async function closeFileWithDjvuCleanup() {
        invalidatePendingDjvuOpen();
        if (isDjvuMode.value) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
        closeFile();
    }

    return {
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    };
};
