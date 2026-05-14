import type { Ref } from 'vue';
import type { IAnnotationNoteWindowState } from '@app/composables/pdf/annotations/annotationNoteWindowTypes';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { ICloseFileFromUiOptions } from '@app/types/workspaceExpose';
import type { TPdfSource } from '@app/types/pdf';
import type { IRecentFile } from '@contracts/shared';
import { waitUntilIdle } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

export interface IPageFileOperationsDeps {
    pdfSrc: Ref<TPdfSource | null>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isAnyAnnotationNoteSaving: Ref<boolean>;
    annotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    annotationDirty: Ref<boolean>;
    isDirty: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    hasAnnotationChanges: () => boolean;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    handleSave: () => Promise<void>;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void | Promise<void>;
    closeAllDropdowns: () => void;
    emitOpenInNewTab: (pathOrResult: TDocumentRef | TOpenFileResult) => void;
    removeRecentFile: (file: IRecentFile) => Promise<void>;
    notifyMissingRecentFile: (file: IRecentFile) => void;
}

export const usePageFileOperations = (deps: IPageFileOperationsDeps) => {
    const {
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
        closeAllDropdowns,
        emitOpenInNewTab,
        removeRecentFile,
        notifyMissingRecentFile,
    } = deps;

    async function waitUntilAllIdle() {
        await waitUntilIdle(() =>
            isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value,
        );
    }

    function getBusyState() {
        return {
            isAnySaving: isAnySaving.value,
            isHistoryBusy: isHistoryBusy.value,
            isExportingDocx: isExportingDocx.value,
            isAnyAnnotationNoteSaving: isAnyAnnotationNoteSaving.value,
        };
    }

    function stringifyError(error: unknown) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    function hasBusyOperation() {
        return isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value;
    }

    function hasPendingPersistenceChanges() {
        return annotationDirty.value
            || isDirty.value
            || hasAnnotationChanges()
            || pageLabelsDirty.value
            || bookmarksDirty.value;
    }

    function logPersistenceGateStart() {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Ensuring document is persisted before switch', {
            busyState: getBusyState(),
            annotationNoteWindows: annotationNoteWindows.value.length,
            annotationDirty: annotationDirty.value,
            isDirty: isDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
        });
    }

    function logPendingChangesAfterSave() {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: pending changes remain after save attempt', {
            annotationDirty: annotationDirty.value,
            isDirty: isDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
        });
    }

    async function persistOpenAnnotationNotes() {
        if (annotationNoteWindows.value.length === 0) {
            return true;
        }

        const savedAllNotes = await persistAllAnnotationNotes(true);
        if (!savedAllNotes) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: failed to persist annotation note windows');
        }
        return savedAllNotes;
    }

    async function savePendingChangesBeforeSwitch() {
        if (!hasPendingPersistenceChanges()) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no pending changes');
            return true;
        }

        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Pending changes detected, triggering save before switch');
        try {
            await handleSave();
        } catch (saveError) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: save before switch threw', {error: stringifyError(saveError)});
            return false;
        }

        const canProceed = !hasPendingPersistenceChanges();
        if (!canProceed) {
            logPendingChangesAfterSave();
        }
        return canProceed;
    }

    async function ensureCurrentDocumentPersistedBeforeSwitch() {
        if (!pdfSrc.value) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no current document loaded');
            return true;
        }

        logPersistenceGateStart();

        try {
            await waitUntilAllIdle();
            if (hasBusyOperation()) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: workspace remained busy after idle wait', {busyState: getBusyState()});
                return false;
            }

            if (!await persistOpenAnnotationNotes()) {
                return false;
            }

            return await savePendingChangesBeforeSwitch();
        } catch (persistError) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: persistence gate threw unexpectedly', {error: stringifyError(persistError)});
            return false;
        }
    }

    async function runPickerWithPersistence(
        pick: () => Promise<TOpenFileResult | null>,
        options: { openGeneratedInNewTab: boolean },
    ) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return false;
        }

        const result = await pick();
        if (!result) {
            return false;
        }

        if (
            options.openGeneratedInNewTab
            && result.kind === 'pdf'
            && result.isGenerated
            && pdfSrc.value
        ) {
            emitOpenInNewTab(result);
            closeAllDropdowns();
            return true;
        }

        const outcome = await openFile(result);
        const opened = didOpenDocument(outcome);
        if (opened) {
            closeAllDropdowns();
        }
        return opened;
    }

    async function handleOpenFileFromUi() {
        return runPickerWithPersistence(pickFileToOpen, { openGeneratedInNewTab: true });
    }

    async function pickCombineFiles() {
        return getDocumentsCapability().openCombineDialog();
    }

    async function handleCombineImages() {
        return runPickerWithPersistence(pickCombineFiles, { openGeneratedInNewTab: true });
    }

    async function pickFolderToOpen() {
        return getDocumentsCapability().openFolderDialog();
    }

    async function handleOpenFolderFromUi() {
        return runPickerWithPersistence(pickFolderToOpen, { openGeneratedInNewTab: true });
    }

    async function handleOpenFileDirectWithPersist(path: TDocumentRef) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'handleOpenFileDirectWithPersist called', {
            path,
            hadDocumentBeforeOpen: Boolean(pdfSrc.value),
            busyState: getBusyState(),
        });

        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Open path aborted by persistence gate', { path });
            return false;
        }
        const outcome = await openFileDirect(path);
        const opened = didOpenDocument(outcome);
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect resolved', {
            path,
            status: outcome.status,
            hasDocumentAfterDirectOpen: Boolean(pdfSrc.value),
        });

        if (!opened) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Open path finished without an active document', {
                path,
                status: outcome.status,
                error: outcome.status === 'failed' ? outcome.error : undefined,
            });
            return false;
        }
        closeAllDropdowns();
        return true;
    }

    async function handleOpenFileWithResult(result: TOpenFileResult) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return false;
        }
        const outcome = await openFile(result);
        const opened = didOpenDocument(outcome);
        if (opened) {
            closeAllDropdowns();
        }
        return opened;
    }

    async function handleOpenFileDirectBatchWithPersist(paths: string[]) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return false;
        }
        const outcome = await openFileDirectBatch(paths);
        const opened = didOpenDocument(outcome);
        if (opened) {
            closeAllDropdowns();
        }
        return opened;
    }

    async function handleCloseFileFromUi(options: ICloseFileFromUiOptions = {}) {
        const shouldPersist = options.persist ?? true;

        if (shouldPersist) {
            const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
            if (!canProceed) {
                return;
            }
        } else {
            await waitUntilAllIdle();
            if (hasBusyOperation()) {
                return;
            }
        }

        await closeFile();
        closeAllDropdowns();
    }

    async function recentFilePathExists(path: TDocumentRef) {
        try {
            await getDocumentsCapability().readFileRange(path, 0, 1);
            return true;
        } catch (probeError) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Recent file probe failed', {
                path,
                error: stringifyError(probeError),
            });
            return false;
        }
    }

    async function openRecentFile(file: IRecentFile) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openRecentFile invoked', {path: file.originalPath});

        if (isBrowserDocumentRef(file.originalPath) && !await recentFilePathExists(file.originalPath)) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Recent file no longer exists; removing from recents', {path: file.originalPath});
            await removeRecentFile(file);
            notifyMissingRecentFile(file);
            return false;
        }

        return handleOpenFileDirectWithPersist(file.originalPath);
    }

    return {
        handleOpenFileFromUi,
        handleOpenFolderFromUi,
        handleCombineImages,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
    };
};
