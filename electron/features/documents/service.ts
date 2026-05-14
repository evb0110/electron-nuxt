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
} from '@electron/features/documents/main/documentFileWriteHandlers';
import {
    handleAnalyzePdfConformance,
    handleValidatePdfData,
    handleValidatePdfPath,
} from '@electron/features/documents/main/documentPdfValidationHandlers';
import { handleCleanupOcrTemp } from '@electron/features/documents/main/documentOcrTempCleanupHandler';
import {
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
} from '@electron/features/documents/main/print';
import { cleanupWorkingCopy } from '@electron/ipc/workingCopyCleanup';
import {
    handleFileSave,
    handleSerializedPdfSave,
} from '@electron/ipc/workingCopySave';
import { beginSerializedPdfSaveToOriginal } from '@electron/features/documents/main/serializedPdfPersistence';
import {
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
} from '@electron/recentFiles';
import {
    allowOpenPaths,
    removeAllowedOpenPath,
} from '@electron/ipc/openPathCapabilities';
import {
    setMenuDocumentState,
    setMenuTabCount,
    updateRecentFilesMenu,
} from '@electron/menu';
import { createLogger } from '@electron/utils/logger';
import type { IDocumentsService } from '@electron/features/documents/ports';

const logger = createLogger('documents-service');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

export function createDocumentsService(): IDocumentsService {
    return {
        openPdfDialog: (event) => handleOpenPdfDialog(event),
        openCombineDialog: (event) => handleOpenCombineDialog(event),
        openFolderDialog: (event) => handleOpenFolderDialog(event),
        openImageDialog: (event) => handleOpenImageDialog(event),
        openPdfDirect: (event, filePath) => handleOpenPdfDirect(event, filePath),
        openPdfDirectBatch: (event, filePaths, requestId) => handleOpenPdfDirectBatch(event, filePaths, requestId),
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
        writeDocxFile: (event, filePath, data) => handleFileWriteDocx(event, filePath, data),
        saveFile: (event, workingPath) => handleFileSave(event, workingPath),
        savePdfData: (event, workingPath, data) => handleSerializedPdfSave(event, workingPath, data),
        beginSavePdfData: (event, workingPath, totalBytes) =>
            beginSerializedPdfSaveToOriginal(event, workingPath, totalBytes),
        cleanupFile: (_event, workingPath) => {
            cleanupWorkingCopy(workingPath);
        },
        cleanupOcrTemp: (event, filePath) => handleCleanupOcrTemp(event, filePath),
        setWindowTitle: (event, title) => handleSetWindowTitle(event, title),
        showItemInFolder: (event, filePath) => handleShowItemInFolder(event, filePath),
        setMenuDocumentState: (event, hasDocument) => {
            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                return;
            }

            setMenuDocumentState(window.id, hasDocument);
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
