import type { Ref } from 'vue';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    cleanupDjvuTemp: () => Promise<void>;
    exitDjvuMode: () => void;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirect: (path: TDocumentRef) => Promise<void>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<void>;
    closeFile: () => void;
}

export const useWorkspaceFileSwitch = (deps: IWorkspaceFileSwitchDeps) => {
    const {
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
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
        await openFile(preSelected);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function openFileDirectWithDjvuCleanup(path: TDocumentRef) {
        const oldPath = workingCopyPath.value;
        await openFileDirect(path);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function openFileDirectBatchWithDjvuCleanup(paths: TDocumentRef[]) {
        const oldPath = workingCopyPath.value;
        await openFileDirectBatch(paths);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function closeFileWithDjvuCleanup() {
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
