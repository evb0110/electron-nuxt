import { BrowserWindow } from 'electron';
import {
    handleCreateWorkingCopyFromData,
    handleOpenCombineDialog,
    handleOpenFolderDialog,
    handleOpenImageDialog,
    handleCreateWorkingCopyFromPath,
    handleOpenPdfDialog,
    handleOpenPdfDirect,
    handleOpenPdfDirectBatch,
    handleSaveDocxAs,
    handleSavePdfAs,
    handleSavePdfDialog,
    handleSetWindowTitle,
    handleShowItemInFolder,
} from '@electron/features/documents/main/dialogs';
import {
    handleAnalyzePdfConformance,
    handleCleanupOcrTemp,
    handleFileExists,
    handleFileRead,
    handleFileReadRange,
    handleFileReadText,
    handleFileStat,
    handleValidatePdfData,
    handleFileWrite,
    handleFileWriteDocx,
} from '@electron/features/documents/main/file-ops';
import {
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
} from '@electron/features/documents/main/print';
import {
    cleanupWorkingCopy,
    handleFileSave,
} from '@electron/ipc/workingCopy';
import {
    clearRecentFiles,
    getRecentFiles,
    removeRecentFile,
} from '@electron/recent-files';
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
        openPdfDialog: () => handleOpenPdfDialog(),
        openCombineDialog: () => handleOpenCombineDialog(),
        openFolderDialog: () => handleOpenFolderDialog(),
        openImageDialog: () => handleOpenImageDialog(),
        openPdfDirect: (event, filePath) => handleOpenPdfDirect(event, filePath),
        openPdfDirectBatch: (event, filePaths, requestId) => handleOpenPdfDirectBatch(event, filePaths, requestId),
        createWorkingCopyFromData: (event, fileName, data, originalPath) =>
            handleCreateWorkingCopyFromData(event, fileName, data, originalPath),
        createWorkingCopyFromPath: (event, sourcePath, originalPath) =>
            handleCreateWorkingCopyFromPath(event, sourcePath, originalPath),
        savePdfAs: (event, workingPath) => handleSavePdfAs(event, workingPath),
        savePdfDialog: (event, suggestedName) => handleSavePdfDialog(event, suggestedName),
        saveDocxAs: (event, workingPath) => handleSaveDocxAs(event, workingPath),
        readFile: (event, filePath) => handleFileRead(event, filePath),
        statFile: (event, filePath) => handleFileStat(event, filePath),
        readFileRange: (event, filePath, offset, length) => handleFileReadRange(event, filePath, offset, length),
        readTextFile: (event, filePath) => handleFileReadText(event, filePath),
        fileExists: (event, filePath) => handleFileExists(event, filePath),
        analyzePdfConformance: (event, filePath) => handleAnalyzePdfConformance(event, filePath),
        validatePdfData: (event, data, fileName) => handleValidatePdfData(event, data, fileName),
        openPdfInDefaultAppData: (event, data, fileName) => handleOpenPdfInDefaultAppData(event, data, fileName),
        openPdfInDefaultAppPath: (event, filePath, fileName) => handleOpenPdfInDefaultAppPath(event, filePath, fileName),
        printPdfData: (event, data, fileName) => handlePrintPdfData(event, data, fileName),
        printPdfPath: (event, filePath, fileName, pageNumbers) => handlePrintPdfPath(event, filePath, fileName, pageNumbers),
        writeFile: (event, filePath, data) => handleFileWrite(event, filePath, data),
        writeDocxFile: (event, filePath, data) => handleFileWriteDocx(event, filePath, data),
        saveFile: (event, workingPath) => handleFileSave(event, workingPath),
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
        getRecentFiles: async () => {
            const startedAt = Date.now();
            const files = await getRecentFiles();
            allowOpenPaths(files.map(file => file.originalPath));
            if (STARTUP_TRACE_ENABLED) {
                logger.info(`[startup] IPC recent-files:get resolved (${files.length} file(s), +${Date.now() - startedAt}ms)`);
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
