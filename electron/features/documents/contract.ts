import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
    type IDocumentFilesInvokeMap,
    type IDocumentOpenInvokeMap,
    type IDocumentPdfInvokeMap,
    type IDocumentWorkingCopyInvokeMap,
} from '@contracts/documentsPlatformFeature';
import type {
    IDocumentsFileCapability,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';

export const DOCUMENTS_CHANNELS = {
    openDocumentDirect: DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirect,
    openDocumentDirectBatch: DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.openDocumentDirectBatch,
    cancelOpenDocumentDirectBatch: DOCUMENT_OPEN_PLATFORM_FEATURE.invokeChannels.cancelOpenDocumentDirectBatch,
    registerRendererFileOpenToken: 'dialog:registerRendererFileOpenToken',
    registerRendererFileOpenTokens: 'dialog:registerRendererFileOpenTokens',
    allowRendererFileOpen: 'dialog:allowRendererFileOpen',
    allowRendererFileOpenBatch: 'dialog:allowRendererFileOpenBatch',
    createWorkingCopyFromData: DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.createWorkingCopyFromData,
    createWorkingCopyFromPath: DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.createWorkingCopyFromPath,
    savePdfAs: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfAs,
    savePdfDataAs: 'dialog:savePdfDataAs',
    savePdfDataAsBegin: 'dialog:savePdfDataAs:begin',
    savePdfDialog: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfDialog,
    saveDocxAs: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.saveDocxAs,
    fileRead: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readFile,
    fileStat: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.statFile,
    fileReadRange: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readFileRange,
    fileCreateManagedHandle: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.createManagedTempFileHandle,
    fileReleaseManagedHandle: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.releaseManagedTempFileHandle,
    pdfOpeningGeometry: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getPdfOpeningGeometry,
    pdfNativePageSizes: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getPdfNativePageSizes,
    pdfNativePagePreviewCancel: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.cancelPdfNativePagePreview,
    pdfNativePagePreview: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.renderPdfNativePagePreview,
    fileReadText: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.readTextFile,
    fileExists: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.fileExists,
    documentRevisionGet: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.getDocumentRevision,
    pdfAnalyzeConformance: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.analyzePdfConformance,
    pdfValidateData: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.validatePdfData,
    pdfValidatePath: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.validatePdfPath,
    pdfOpenInDefaultAppData: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.openPdfInDefaultAppData,
    pdfOpenInDefaultAppPath: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.openPdfInDefaultAppPath,
    pdfPrintData: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.printPdfData,
    pdfPrintPath: DOCUMENT_PDF_PLATFORM_FEATURE.invokeChannels.printPdfPath,
    fileWrite: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.writeFile,
    fileReplaceWorkingCopyFromPath: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.replaceWorkingCopyFromPath,
    fileWriteDocx: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.writeDocxFile,
    fileSaveStructured: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.saveFileStructured,
    fileResyncWorkingCopy: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.resyncWorkingCopy,
    fileRepairPdf: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.repairPdf,
    fileOptimizePdfForInteraction: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.optimizePdfForInteraction,
    fileOptimizePdfAsCopy: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.optimizePdfAsCopy,
    fileSavePdfData: 'file:savePdfData',
    fileSavePdfDataBegin: 'file:savePdfData:begin',
    fileSavePdfDataPort: 'file:savePdfData:port',
    fileCommitStagedSerializedPdf: 'file:commitStagedSerializedPdf',
    fileCancelStagedSerializedPdf: 'file:cancelStagedSerializedPdf',
    fileSavePdfNoteTextUpdates: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNoteTextUpdates,
    fileSavePdfNoteChanges: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNoteChanges,
    fileSavePdfNativeMutations: DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.savePdfNativeMutations,
    fileApplyPdfNativeMutationsToWorkingCopy:
        DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.applyPdfNativeMutationsToWorkingCopy,
    fileCommitStagedPdfNativeMutations:
        DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels.commitStagedPdfNativeMutations,
    fileCleanup: DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.cleanupFile,
    fileCleanupOcrTemp: DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.cleanupOcrTemp,
} as const;

export const DOCUMENTS_EVENT_CHANNELS = {documentRevisionChanged: DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onDocumentRevisionChanged} as const;

interface IDocumentsDirectPersistenceInvokeMap {
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        args: [token: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        args: [tokens: string[]];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        args: [request: {
            filePath: string;
            token: string;
        }];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        args: [requests: Array<{
            filePath: string;
            token: string;
        }>];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAs]: {
        args: [
            workingPath: string,
            data: Uint8Array,
            options?: IPdfSaveAsOptions,
            serializedSaveOptions?: IPdfSerializedSaveOptions,
        ];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfDataAs']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: {
        args: [
            workingPath: string,
            totalBytes: number,
            options?: IPdfSaveAsOptions,
            serializedSaveOptions?: IPdfSerializedSaveOptions,
        ];
        result: IBeginSerializedPdfSaveAsResult;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfData]: {
        args: [path: string, data: Uint8Array, options?: IPdfSerializedSaveOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfData']>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        args: [path: string, totalBytes: number, options?: IPdfSerializedSaveOptions];
        result: IBeginSerializedPdfPersistenceResult;
    };
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: {
        args: [
            sessionId: string,
            stagedOutput: ITypedStagedArtifact,
        ];
        result: {
            path: string | null;
            validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
        };
    };
    [DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf]: {
        args: [
            sessionId: string,
            stagedOutput: ITypedStagedArtifact,
        ];
        result: boolean;
    };
}

export type IDocumentsInvokeMap =
    IDocumentOpenInvokeMap
    & IDocumentWorkingCopyInvokeMap
    & IDocumentFilesInvokeMap
    & IDocumentPdfInvokeMap
    & IDocumentsDirectPersistenceInvokeMap;

export type { TOpenFileResult } from '@contracts/electronApiDocuments';
