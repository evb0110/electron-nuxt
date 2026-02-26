import type { Ref } from 'vue';
import type { IAnnotationNoteWindowState } from '@app/composables/pdf/annotations/types';
import type { TOpenFileResult } from '@app/types/electron-api';
import type { ICloseFileFromUiOptions } from '@app/types/workspace-expose';
import type { TPdfSource } from '@app/types/pdf';
import type { IRecentFile } from '@app/types/shared';
import { waitUntilIdle } from '@app/utils/async-helpers';
import { BrowserLogger } from '@app/utils/browser-logger';

const DJVU_PATH_REGEX = /\.djvu?$/i;
const OPEN_SETTLE_DELAY_MS = 25;
const OPEN_SETTLE_MAX_ATTEMPTS = 160;
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
    openFile: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirect: (path: string) => Promise<void>;
    openFileDirectBatch: (paths: string[]) => Promise<void>;
    closeFile: () => Promise<void>;
    closeAllDropdowns: () => void;
    emitOpenInNewTab: (result: TOpenFileResult) => void;
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

    async function waitForDocumentSource() {
        await waitUntilIdle(
            () => !pdfSrc.value,
            {
                delayMs: OPEN_SETTLE_DELAY_MS,
                maxAttempts: OPEN_SETTLE_MAX_ATTEMPTS,
            },
        );
        return Boolean(pdfSrc.value);
    }

    async function ensureCurrentDocumentPersistedBeforeSwitch() {
        if (!pdfSrc.value) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no current document loaded');
            return true;
        }

        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Ensuring document is persisted before switch', {
            busyState: getBusyState(),
            annotationNoteWindows: annotationNoteWindows.value.length,
            annotationDirty: annotationDirty.value,
            isDirty: isDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
        });

        try {
            await waitUntilAllIdle();
            if (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: workspace remained busy after idle wait', {busyState: getBusyState()});
                return false;
            }

            if (annotationNoteWindows.value.length > 0) {
                const savedAllNotes = await persistAllAnnotationNotes(true);
                if (!savedAllNotes) {
                    BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: failed to persist annotation note windows');
                    return false;
                }
            }

            const hasPendingChanges = (
                annotationDirty.value
                || isDirty.value
                || hasAnnotationChanges()
                || pageLabelsDirty.value
                || bookmarksDirty.value
            );
            if (!hasPendingChanges) {
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

            const canProceed = !(
                annotationDirty.value
                || isDirty.value
                || hasAnnotationChanges()
                || pageLabelsDirty.value
                || bookmarksDirty.value
            );
            if (!canProceed) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: pending changes remain after save attempt', {
                    annotationDirty: annotationDirty.value,
                    isDirty: isDirty.value,
                    pageLabelsDirty: pageLabelsDirty.value,
                    bookmarksDirty: bookmarksDirty.value,
                });
            }
            return canProceed;
        } catch (persistError) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: persistence gate threw unexpectedly', {error: stringifyError(persistError)});
            return false;
        }
    }

    async function handleOpenFileFromUi() {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }

        const result = await pickFileToOpen();
        if (!result) {
            return;
        }

        if (result.kind === 'pdf' && result.isGenerated && pdfSrc.value) {
            emitOpenInNewTab(result);
            closeAllDropdowns();
            return;
        }

        await openFile(result);
        closeAllDropdowns();
    }

    async function handleOpenFileDirectWithPersist(path: string) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'handleOpenFileDirectWithPersist called', {
            path,
            hadDocumentBeforeOpen: Boolean(pdfSrc.value),
            busyState: getBusyState(),
        });

        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Open path aborted by persistence gate', { path });
            return;
        }
        await openFileDirect(path);
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect resolved', {
            path,
            hasDocumentAfterDirectOpen: Boolean(pdfSrc.value),
        });

        if (!pdfSrc.value && !DJVU_PATH_REGEX.test(path)) {
            const settled = await waitForDocumentSource();
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Post-open settle wait finished', {
                path,
                settled,
                hasDocumentAfterSettle: Boolean(pdfSrc.value),
            });

            if (!settled) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Document still missing after first open, retrying once', {path});
                await openFileDirect(path);
                const settledAfterRetry = await waitForDocumentSource();
                BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Retry settle finished', {
                    path,
                    settledAfterRetry,
                    hasDocumentAfterRetry: Boolean(pdfSrc.value),
                });
            }
        }
        closeAllDropdowns();
    }

    async function handleOpenFileWithResult(result: TOpenFileResult) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }
        await openFile(result);
        closeAllDropdowns();
    }

    async function handleOpenFileDirectBatchWithPersist(paths: string[]) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }
        await openFileDirectBatch(paths);
        closeAllDropdowns();
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
            if (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value) {
                return;
            }
        }

        await closeFile();
        closeAllDropdowns();
    }

    async function openRecentFile(file: Pick<IRecentFile, 'originalPath'>) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openRecentFile invoked', {path: file.originalPath});
        await handleOpenFileDirectWithPersist(file.originalPath);
    }

    return {
        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFile,
    };
};
