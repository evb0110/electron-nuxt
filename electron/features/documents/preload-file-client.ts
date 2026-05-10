import type { IpcRenderer } from 'electron';
import type {
    IDocumentsFileCapability,
    IImageExportCapability,
} from '@contracts/platform-api';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/index';
import { createIpcInvoker } from '@electron/preload/ipc-client';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWorkingCopyFileName,
    assertWriteData,
    MAX_IPC_FILE_NAME_LENGTH,
} from '@electron/features/documents/preload-shared';

type TDocumentsPreloadFileClient = Omit<IDocumentsFileCapability, 'getPathForFile'> & IImageExportCapability;

function assertPositiveInteger(value: number, label: string) {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

export function createDocumentsPreloadFileClient(
    ipcRenderer: IpcRenderer,
): TDocumentsPreloadFileClient {
    const invoke = createIpcInvoker(ipcRenderer);

    return {
        openPdfDialog: () => invoke(DOCUMENTS_CHANNELS.openPdfDialog),
        openCombineDialog: () => invoke(DOCUMENTS_CHANNELS.openCombineDialog),
        openFolderDialog: () => invoke(DOCUMENTS_CHANNELS.openFolderDialog),
        openImageDialog: () => invoke(DOCUMENTS_CHANNELS.openImageDialog),
        openPdfDirect: (path: string) => invoke(DOCUMENTS_CHANNELS.openPdfDirect, path),
        openPdfDirectBatch: (paths: string[], requestId?: string) =>
            invoke(DOCUMENTS_CHANNELS.openPdfDirectBatch, paths, requestId),
        savePdfAs: (workingPath: string) => invoke(DOCUMENTS_CHANNELS.savePdfAs, workingPath),
        savePdfDialog: (suggestedName: string) => invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath: string) => invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        exportPdfToImages: (workingPath: string, pageNumbers?: number[]) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportImages, workingPath, pageNumbers),
        exportPdfToMultiPageTiff: (workingPath: string, pageNumbers?: number[]) =>
            invoke(IMAGE_EXPORT_CHANNELS.exportMultiPageTiff, workingPath, pageNumbers),
        readFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path: string, offset: number, length: number) =>
            invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
        readTextFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileReadText, path),
        fileExists: (path: string) => invoke(DOCUMENTS_CHANNELS.fileExists, path),
        analyzePdfConformance: (path: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfAnalyzeConformance,
                assertAbsolutePath(path, 'analyzePdfConformance.path'),
            ),
        validatePdfData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidateData,
                assertWriteData(data, 'validatePdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'validatePdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
                assertWriteData(data, 'openPdfInDefaultAppData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        openPdfInDefaultAppPath: (path: string, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
                assertAbsolutePath(path, 'openPdfInDefaultAppPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfData: (data: Uint8Array, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintData,
                assertWriteData(data, 'printPdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfPath: (path: string, fileName?: string, pageNumbers?: number[]) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintPath,
                assertAbsolutePath(path, 'printPdfPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
                Array.isArray(pageNumbers)
                    ? pageNumbers.map((pageNumber, index) => assertPositiveInteger(pageNumber, `printPdfPath.pageNumbers[${index}]`))
                    : undefined,
            ),
        writeFile: (path: string, data: Uint8Array) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
            ),
        writeDocxFile: (path: string, data: Uint8Array) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWriteDocx,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'),
            ),
        createWorkingCopyFromPath: (sourcePath: string, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'),
            ),
        saveFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileSave, path),
        cleanupFile: (path: string) => invoke(DOCUMENTS_CHANNELS.fileCleanup, path),
        cleanupOcrTemp: (path: string) => invoke(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, path),
        setWindowTitle: (title: string) => invoke(DOCUMENTS_CHANNELS.windowSetTitle, title),
        showItemInFolder: (path: string) => invoke(DOCUMENTS_CHANNELS.shellShowItemInFolder, path),
        recentFiles: {
            get: () => invoke(DOCUMENTS_CHANNELS.recentFilesGet),
            remove: (path: string) => invoke(DOCUMENTS_CHANNELS.recentFilesRemove, path),
            clear: () => invoke(DOCUMENTS_CHANNELS.recentFilesClear),
        },
    };
}
