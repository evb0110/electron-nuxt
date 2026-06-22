import { BrowserWindow } from 'electron';
import {
    handleOpenCombineDialog,
    handleOpenFolderDialog,
    handleOpenImageDialog,
    handleOpenPdfDialog,
    handleOpenPdfDirect,
    handleOpenPdfDirectBatch,
} from '@electron/features/documents/main/documentOpenHandlers';
import {
    handleBeginSavePdfDataAs,
    handleSaveDocxAs,
    handleSavePdfAs,
    handleSavePdfDataAs,
    handleSavePdfDialog,
} from '@electron/features/documents/main/documentSaveDialogHandlers';
import {
    handleSetWindowTitle,
    handleShowItemInFolder,
} from '@electron/features/documents/main/documentWindowHandlers';
import {
    handleCreateWorkingCopyFromData,
    handleCreateWorkingCopyFromPath,
} from '@electron/features/documents/main/documentWorkingCopyHandlers';
import {
    handleFileExists,
    handleFileRead,
    handleFileReadRange,
    handleFileReadText,
    handleFileStat,
} from '@electron/features/documents/main/documentFileReadHandlers';
import {
    handleFileWrite,
    handleFileWriteDocx,
    handleReplaceWorkingCopyFromPath,
} from '@electron/features/documents/main/documentFileWriteHandlers';
import {
    handleAnalyzePdfConformance,
    handleValidatePdfData,
    handleValidatePdfPath,
} from '@electron/features/documents/main/documentPdfValidationHandlers';
import { handleCleanupOcrTemp } from '@electron/features/documents/main/handleCleanupOcrTemp';
import {
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
} from '@electron/features/documents/main/print';
import { cleanupWorkingCopy } from '@electron/file-access/workingCopyCleanup';
import {
    handleFileSave,
    handleOptimizePdfForInteraction,
    handleRepairPdfSave,
    handleSerializedPdfSave,
} from '@electron/features/documents/main/workingCopySave';
import { handleOptimizePdfAsCopy } from '@electron/features/documents/main/handleOptimizePdfAsCopy';
import {
    handleNativePdfMutationsApplyToWorkingCopy,
    handleNativeNoteChangesSave,
    handleNativeNoteTextSave,
    handleNativePdfMutationsSave,
} from '@electron/features/documents/main/nativePdfMutationSaveHandlers';
import { beginSerializedPdfSaveToOriginal } from '@electron/features/documents/main/serializedPdfPersistence';
import {
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
} from '@electron/recentFiles';
import {
    allowOpenPaths,
    removeAllowedOpenPath,
} from '@electron/file-access/openPathCapabilities';
import {
    setMenuDocumentState,
    setMenuTabCount,
    updateRecentFilesMenu,
} from '@electron/menu';
import { createLogger } from '@electron/utils/createLogger';
import type { IDocumentsService } from '@electron/features/documents/documentsService';

const logger = createLogger('documents-service');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

type TDocumentsServiceArgs<TMethod extends keyof IDocumentsService> =
    IDocumentsService[TMethod] extends (...args: infer TArgs) => unknown ? TArgs : never;

export function createDocumentsService(): IDocumentsService {
    const service: IDocumentsService = {
        openDocumentDialog: handleOpenPdfDialog,
        openPdfDialog: handleOpenPdfDialog,
        openCombineDialog: (...args: TDocumentsServiceArgs<'openCombineDialog'>) => handleOpenCombineDialog(...args),
        openFolderDialog: (...args: TDocumentsServiceArgs<'openFolderDialog'>) => handleOpenFolderDialog(...args),
        openImageDialog: (...args: TDocumentsServiceArgs<'openImageDialog'>) => handleOpenImageDialog(...args),
        openDocumentDirect: handleOpenPdfDirect,
        openPdfDirect: handleOpenPdfDirect,
        openDocumentDirectBatch: handleOpenPdfDirectBatch,
        openPdfDirectBatch: handleOpenPdfDirectBatch,
        createWorkingCopyFromData: (...args: TDocumentsServiceArgs<'createWorkingCopyFromData'>) =>
            handleCreateWorkingCopyFromData(...args),
        createWorkingCopyFromPath: (...args: TDocumentsServiceArgs<'createWorkingCopyFromPath'>) =>
            handleCreateWorkingCopyFromPath(...args),
        savePdfAs: (...args: TDocumentsServiceArgs<'savePdfAs'>) => handleSavePdfAs(...args),
        savePdfDataAs: (...args: TDocumentsServiceArgs<'savePdfDataAs'>) => handleSavePdfDataAs(...args),
        beginSavePdfDataAs: (...args: TDocumentsServiceArgs<'beginSavePdfDataAs'>) =>
            handleBeginSavePdfDataAs(...args),
        savePdfDialog: (...args: TDocumentsServiceArgs<'savePdfDialog'>) => handleSavePdfDialog(...args),
        saveDocxAs: (...args: TDocumentsServiceArgs<'saveDocxAs'>) => handleSaveDocxAs(...args),
        readFile: (...args: TDocumentsServiceArgs<'readFile'>) => handleFileRead(...args),
        statFile: (...args: TDocumentsServiceArgs<'statFile'>) => handleFileStat(...args),
        readFileRange: (...args: TDocumentsServiceArgs<'readFileRange'>) => handleFileReadRange(...args),
        readTextFile: (...args: TDocumentsServiceArgs<'readTextFile'>) => handleFileReadText(...args),
        fileExists: (...args: TDocumentsServiceArgs<'fileExists'>) => handleFileExists(...args),
        analyzePdfConformance: (...args: TDocumentsServiceArgs<'analyzePdfConformance'>) =>
            handleAnalyzePdfConformance(...args),
        validatePdfData: (...args: TDocumentsServiceArgs<'validatePdfData'>) => handleValidatePdfData(...args),
        validatePdfPath: (...args: TDocumentsServiceArgs<'validatePdfPath'>) => handleValidatePdfPath(...args),
        openPdfInDefaultAppData: (...args: TDocumentsServiceArgs<'openPdfInDefaultAppData'>) =>
            handleOpenPdfInDefaultAppData(...args),
        openPdfInDefaultAppPath: (...args: TDocumentsServiceArgs<'openPdfInDefaultAppPath'>) =>
            handleOpenPdfInDefaultAppPath(...args),
        printPdfData: (...args: TDocumentsServiceArgs<'printPdfData'>) => handlePrintPdfData(...args),
        printPdfPath: (...args: TDocumentsServiceArgs<'printPdfPath'>) => handlePrintPdfPath(...args),
        writeFile: (...args: TDocumentsServiceArgs<'writeFile'>) => handleFileWrite(...args),
        replaceWorkingCopyFromPath: (...args: TDocumentsServiceArgs<'replaceWorkingCopyFromPath'>) =>
            handleReplaceWorkingCopyFromPath(...args),
        writeDocxFile: (...args: TDocumentsServiceArgs<'writeDocxFile'>) => handleFileWriteDocx(...args),
        saveFile: (...args: TDocumentsServiceArgs<'saveFile'>) => handleFileSave(...args),
        repairPdf: (...args: TDocumentsServiceArgs<'repairPdf'>) => handleRepairPdfSave(...args),
        optimizePdfForInteraction: (...args: TDocumentsServiceArgs<'optimizePdfForInteraction'>) =>
            handleOptimizePdfForInteraction(...args),
        optimizePdfAsCopy: (...args: TDocumentsServiceArgs<'optimizePdfAsCopy'>) =>
            handleOptimizePdfAsCopy(...args),
        savePdfData: (...args: TDocumentsServiceArgs<'savePdfData'>) => handleSerializedPdfSave(...args),
        savePdfNoteTextUpdates: (...args: TDocumentsServiceArgs<'savePdfNoteTextUpdates'>) =>
            handleNativeNoteTextSave(...args),
        savePdfNoteChanges: (...args: TDocumentsServiceArgs<'savePdfNoteChanges'>) =>
            handleNativeNoteChangesSave(...args),
        savePdfNativeMutations: (...args: TDocumentsServiceArgs<'savePdfNativeMutations'>) =>
            handleNativePdfMutationsSave(...args),
        applyPdfNativeMutationsToWorkingCopy: (...args: TDocumentsServiceArgs<'applyPdfNativeMutationsToWorkingCopy'>) =>
            handleNativePdfMutationsApplyToWorkingCopy(...args),
        beginSavePdfData: (...args: TDocumentsServiceArgs<'beginSavePdfData'>) =>
            beginSerializedPdfSaveToOriginal(...args),
        cleanupFile: (...args: TDocumentsServiceArgs<'cleanupFile'>) => {
            const [
                event,
                workingPath,
            ] = args;
            cleanupWorkingCopy(workingPath, event.sender.id);
        },
        cleanupOcrTemp: (...args: TDocumentsServiceArgs<'cleanupOcrTemp'>) => handleCleanupOcrTemp(...args),
        setWindowTitle: (...args: TDocumentsServiceArgs<'setWindowTitle'>) => handleSetWindowTitle(...args),
        showItemInFolder: (...args: TDocumentsServiceArgs<'showItemInFolder'>) => handleShowItemInFolder(...args),
        setMenuDocumentState: (...args: TDocumentsServiceArgs<'setMenuDocumentState'>) => {
            const [
                event,
                state,
            ] = args;
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return;
            }

            setMenuDocumentState(window.id, state);
        },
        setMenuTabCount: (...args: TDocumentsServiceArgs<'setMenuTabCount'>) => {
            const [
                event,
                tabCount,
            ] = args;
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return;
            }

            setMenuTabCount(window.id, tabCount);
        },
        getRecentFiles: async (...args: TDocumentsServiceArgs<'getRecentFiles'>) => {
            const [event] = args;
            const startedAt = Date.now();
            const files = await getRecentFiles();
            // Grant reveal-in-folder capability for each recent path to the
            // requesting webContents; without this, showItemInFolder is rejected
            // by requireOpenPath for paths the user has not opened this session.
            allowOpenPaths(files.map(file => file.originalPath), event.sender);
            if (STARTUP_TRACE_ENABLED) {
                logger.info(`[startup] IPC recentFiles:get resolved (${files.length} file(s), +${Date.now() - startedAt}ms)`);
            }
            return files;
        },
        removeRecentFile: async (...args: TDocumentsServiceArgs<'removeRecentFile'>) => {
            const [
                ,
                originalPath,
            ] = args;
            await removeRecentFile(originalPath);
            removeAllowedOpenPath(originalPath);
            updateRecentFilesMenu();
        },
        clearRecentFiles: async () => {
            const files = await getRecentFiles();
            await clearRecentFiles();
            files.forEach(file => removeAllowedOpenPath(file.originalPath));
            updateRecentFilesMenu();
        },
    };

    return service;
}
