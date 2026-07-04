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
    handlePdfNativePagePreview,
    handlePdfNativePageSizes,
} from '@electron/features/documents/main/nativePdfPreview';
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
    handleFileSaveStructured,
    handleOptimizePdfForInteraction,
    handleRepairPdfSave,
    handleResyncWorkingCopy,
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
    allowRevealPaths,
    removeAllowedOpenPath,
    removeAllowedRevealPath,
} from '@electron/file-access/openPathCapabilities';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
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
        getPdfNativePageSizes: (...args: TDocumentsServiceArgs<'getPdfNativePageSizes'>) =>
            handlePdfNativePageSizes(...args),
        renderPdfNativePagePreview: (...args: TDocumentsServiceArgs<'renderPdfNativePagePreview'>) =>
            handlePdfNativePagePreview(...args),
        readTextFile: (...args: TDocumentsServiceArgs<'readTextFile'>) => handleFileReadText(...args),
        fileExists: (...args: TDocumentsServiceArgs<'fileExists'>) => handleFileExists(...args),
        getDocumentRevision: (...args: TDocumentsServiceArgs<'getDocumentRevision'>) => {
            const [
                context,
                filePath,
            ] = args;
            return getWorkingCopyRevision(filePath, context.senderId);
        },
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
        saveFileStructured: (...args: TDocumentsServiceArgs<'saveFileStructured'>) =>
            handleFileSaveStructured(...args),
        resyncWorkingCopy: (...args: TDocumentsServiceArgs<'resyncWorkingCopy'>) =>
            handleResyncWorkingCopy(...args),
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
                context,
                workingPath,
            ] = args;
            cleanupWorkingCopy(workingPath, context.senderId);
        },
        cleanupOcrTemp: (...args: TDocumentsServiceArgs<'cleanupOcrTemp'>) => handleCleanupOcrTemp(...args),
        setWindowTitle: (...args: TDocumentsServiceArgs<'setWindowTitle'>) => handleSetWindowTitle(...args),
        showItemInFolder: (...args: TDocumentsServiceArgs<'showItemInFolder'>) => handleShowItemInFolder(...args),
        setMenuDocumentState: (...args: TDocumentsServiceArgs<'setMenuDocumentState'>) => {
            const [
                context,
                state,
            ] = args;
            if (!context.window) {
                return;
            }

            setMenuDocumentState(context.window.id, state);
        },
        setMenuTabCount: (...args: TDocumentsServiceArgs<'setMenuTabCount'>) => {
            const [
                context,
                tabCount,
            ] = args;
            if (!context.window) {
                return;
            }

            setMenuTabCount(context.window.id, tabCount);
        },
        getRecentFiles: async (...args: TDocumentsServiceArgs<'getRecentFiles'>) => {
            const [context] = args;
            const startedAt = Date.now();
            const files = await getRecentFiles();
            allowRevealPaths(files.map(file => file.originalPath), context.sender);
            if (STARTUP_TRACE_ENABLED) {
                logger.info(`[startup] IPC recentFiles:get resolved (${files.length} file(s), +${Date.now() - startedAt}ms)`);
            }
            return files;
        },
        removeRecentFile: async (...args: TDocumentsServiceArgs<'removeRecentFile'>) => {
            const [originalPath] = args;
            await removeRecentFile(originalPath);
            removeAllowedOpenPath(originalPath);
            removeAllowedRevealPath(originalPath);
            updateRecentFilesMenu();
        },
        clearRecentFiles: async () => {
            const files = await getRecentFiles();
            await clearRecentFiles();
            files.forEach(file => {
                removeAllowedOpenPath(file.originalPath);
                removeAllowedRevealPath(file.originalPath);
            });
            updateRecentFilesMenu();
        },
    };

    return service;
}
