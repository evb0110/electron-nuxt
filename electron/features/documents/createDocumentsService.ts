import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
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
    handleSerializedPdfSave,
} from '@electron/features/documents/main/workingCopySave';
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

export function createDocumentsService(): IDocumentsService {
    const openDocumentDialog = (event: IpcMainInvokeEvent) => handleOpenPdfDialog(event);
    const openDocumentDirect = (event: IpcMainInvokeEvent, filePath: string) =>
        handleOpenPdfDirect(event, filePath);
    const openDocumentDirectBatch = (
        event: IpcMainInvokeEvent,
        filePaths: string[],
        requestId?: string,
    ) => handleOpenPdfDirectBatch(event, filePaths, requestId);

    return {
        openDocumentDialog,
        openPdfDialog: openDocumentDialog,
        openCombineDialog: (event) => handleOpenCombineDialog(event),
        openFolderDialog: (event) => handleOpenFolderDialog(event),
        openImageDialog: (event) => handleOpenImageDialog(event),
        openDocumentDirect,
        openPdfDirect: openDocumentDirect,
        openDocumentDirectBatch,
        openPdfDirectBatch: openDocumentDirectBatch,
        createWorkingCopyFromData: (event, fileName, data, originalPath) =>
            handleCreateWorkingCopyFromData(event, fileName, data, originalPath),
        createWorkingCopyFromPath: (event, sourcePath, originalPath) =>
            handleCreateWorkingCopyFromPath(event, sourcePath, originalPath),
        savePdfAs: (event, workingPath) => handleSavePdfAs(event, workingPath),
        savePdfDataAs: (event, workingPath, data) => handleSavePdfDataAs(event, workingPath, data),
        beginSavePdfDataAs: (event, workingPath, totalBytes) =>
            handleBeginSavePdfDataAs(event, workingPath, totalBytes),
        savePdfDialog: (event, suggestedName) => handleSavePdfDialog(event, suggestedName),
        saveDocxAs: (event, workingPath) => handleSaveDocxAs(event, workingPath),
        readFile: (event, filePath) => handleFileRead(event, filePath),
        statFile: (event, filePath) => handleFileStat(event, filePath),
        readFileRange: (event, filePath, offset, length) => handleFileReadRange(event, filePath, offset, length),
        readTextFile: (event, filePath) => handleFileReadText(event, filePath),
        fileExists: (event, filePath) => handleFileExists(event, filePath),
        analyzePdfConformance: (event, filePath) => handleAnalyzePdfConformance(event, filePath),
        validatePdfData: (event, data, fileName) => handleValidatePdfData(event, data, fileName),
        validatePdfPath: (event, filePath) => handleValidatePdfPath(event, filePath),
        openPdfInDefaultAppData: (event, data, fileName) => handleOpenPdfInDefaultAppData(event, data, fileName),
        openPdfInDefaultAppPath: (event, filePath, fileName) => handleOpenPdfInDefaultAppPath(event, filePath, fileName),
        printPdfData: (event, data, fileName) => handlePrintPdfData(event, data, fileName),
        printPdfPath: (event, filePath, fileName, pageNumbers) => handlePrintPdfPath(event, filePath, fileName, pageNumbers),
        writeFile: (event, filePath, data) => handleFileWrite(event, filePath, data),
        replaceWorkingCopyFromPath: (event, workingCopyPath, sourcePath) =>
            handleReplaceWorkingCopyFromPath(event, workingCopyPath, sourcePath),
        writeDocxFile: (event, filePath, data) => handleFileWriteDocx(event, filePath, data),
        saveFile: (event, workingPath) => handleFileSave(event, workingPath),
        savePdfData: (event, workingPath, data) => handleSerializedPdfSave(event, workingPath, data),
        beginSavePdfData: (event, workingPath, totalBytes) =>
            beginSerializedPdfSaveToOriginal(event, workingPath, totalBytes),
        cleanupFile: (event, workingPath) => {
            cleanupWorkingCopy(workingPath, event.sender.id);
        },
        cleanupOcrTemp: (event, filePath) => handleCleanupOcrTemp(event, filePath),
        setWindowTitle: (event, title) => handleSetWindowTitle(event, title),
        showItemInFolder: (event, filePath) => handleShowItemInFolder(event, filePath),
        setMenuDocumentState: (event, state) => {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return;
            }

            setMenuDocumentState(window.id, state);
        },
        setMenuTabCount: (event, tabCount) => {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return;
            }

            setMenuTabCount(window.id, tabCount);
        },
        getRecentFiles: async (event) => {
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
        removeRecentFile: async (_event, originalPath) => {
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
}
